// SPDX-License-Identifier: MIT
/**
 * Gap report B3 — Library Import. Two things this closes:
 *  1. `RootFoldersService.unmapped()` (GET /root-folders/:id/unmapped) enumerates the top-level
 *     folder entries of a root folder that aren't already mapped to an added title, with
 *     best-effort TMDB search pre-fill hints — skipping special folders (Sonarr's list) and the
 *     configured recycle-bin/downloads paths by absolute comparison.
 *  2. The stored folder-name override end-to-end: adding a title with a NON-conventional
 *     on-disk folder name (folderName override) and having the on-add scan pick up real files
 *     that live in that folder — what makes imported/newly-added titles whose folders don't
 *     follow the movieFolderName()/seriesFolderName() convention actually usable.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { EventBus } from "@medianexus/events";
import { createDb, schema } from "@medianexus/database";
import { createMovieSchema, createSeriesSchema, updateMovieSchema } from "@medianexus/domain";
import { RootFoldersService } from "../src/root-folders/root-folders.service";
import { ConfigService } from "../src/system/config.service";
import { MoviesService } from "../src/movies/movies.service";
import { SeriesService } from "../src/series/series.service";
import { AutoTagsService } from "../src/auto-tags/auto-tags.service";
import { RecycleBinService } from "../src/media/recycle-bin.service";
import { LibraryScanService } from "../src/library-scan/library-scan.service";
import { MediaRepository } from "../src/media/media.repository";
import { EventsService } from "../src/events/events.service";
import { MetadataService } from "../src/metadata/metadata.service";

const dir = mkdtempSync(join(tmpdir(), "mn-import-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });

let counter = 0;
async function harness() {
  const id = `imp-${counter++}`;
  const handle = createDb(join(dir, `${id}.db`));
  handle.runMigrations();
  handles.push(handle);
  const db = handle.db;
  const config = new ConfigService(db);
  const rootFolders = new RootFoldersService(db, config);
  const events = new EventsService(new EventBus());
  const mediaRepo = new MediaRepository(db);
  const scan = new LibraryScanService(db, mediaRepo, events);
  const movies = new MoviesService(db, events, new AutoTagsService(db), config, undefined as never, new RecycleBinService(config));
  const series = new SeriesService(db, events, new AutoTagsService(db), config, undefined as never, new RecycleBinService(config));
  return { db, config, rootFolders, scan, movies, series };
}

function stageFile(path: string, size = 2048) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, Buffer.alloc(size));
}

describe("folderName validation (path-traversal surface)", () => {
  it("accepts a plain folder name on create", () => {
    const parsed = createMovieSchema.parse({ title: "X", folderName: "My_Great_Movie_(1999)", rootFolderPath: "/m" });
    expect(parsed.folderName).toBe("My_Great_Movie_(1999)");
  });

  it("rejects path traversal on create (separator, '..', null byte, empty)", () => {
    for (const bad of ["../evil", "a/b", "a\\b", "..", "evil\0", " "]) {
      expect(() => createMovieSchema.parse({ title: "X", folderName: bad })).toThrow();
    }
    expect(() => createSeriesSchema.parse({ title: "X", folderName: "a/../b" })).toThrow();
  });

  it("allows null to clear the override and omitted to leave it unchanged on update", () => {
    expect(updateMovieSchema.parse({ folderName: null }).folderName).toBeNull();
    expect(updateMovieSchema.parse({}).folderName).toBeUndefined();
  });
});

describe("RootFoldersService.unmapped", () => {
  it("lists unmapped folders with hints, excluding specials/downloads/recycle/mapped", async () => {
    const h = await harness();
    const mediaRoot = mkdtempSync(join(dir, "media-"));
    const downloads = join(mediaRoot, "downloads");
    const trash = join(mediaRoot, ".trash");
    stageFile(join(downloads, "x.mkv"));
    stageFile(join(trash, "old.mkv"));
    stageFile(join(mediaRoot, "$recycle.bin", "junk.mkv"));
    // Movie hint: "Title (YYYY)".
    stageFile(join(mediaRoot, "The.Matrix.(1999)", "The.Matrix.1999.1080p.BluRay.mkv"));
    // Series hint: has a "Season 1" subdirectory.
    stageFile(join(mediaRoot, "Breaking.Bad", "Season 1", "ep.mkv"));
    // An already-mapped title's folder.
    stageFile(join(mediaRoot, "Already.Mapped", "f.mkv"));
    const rf = await h.rootFolders.create({ path: mediaRoot, name: "", isDefault: true });
    await h.config.upsert({ "paths.downloads": downloads, "media.recycleBinPath": trash });

    // Map a title to "Already.Mapped" at this root (folder-name override -> non-conventional).
    await h.db.insert(schema.movie).values({
      id: "m1", tmdbId: 1, title: "Already Mapped", overview: "", status: "released", releaseDate: "2001-01-01",
      monitored: true, qualityProfileId: null, rootFolderPath: mediaRoot, folderName: "Already.Mapped",
      minimumAvailability: "announced", genres: [], images: [], tags: [], hasFile: false, addedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    const { items } = await h.rootFolders.unmapped(rf.id);
    const names = items.map((i) => i.name);
    expect(names).toContain("The.Matrix.(1999)");
    expect(names).toContain("Breaking.Bad");
    // Excluded: special folder, downloads path, recycle path, already-mapped title.
    expect(names).not.toContain("$recycle.bin");
    expect(names).not.toContain("downloads");
    expect(names).not.toContain(".trash");
    expect(names).not.toContain("Already.Mapped");

    const matrix = items.find((i) => i.name === "The.Matrix.(1999)")!;
    expect(matrix.suggestedTitle).toBe("The Matrix");
    expect(matrix.suggestedYear).toBe(1999);
    const bb = items.find((i) => i.name === "Breaking.Bad")!;
    expect(bb.suggestedMediaType).toBe("series");
    expect(bb.suggestedTitle).toBe("Breaking Bad");
  });
});

describe("Library Import end-to-end (folder-name override)", () => {
  it("adds a movie into a non-conventional folder and the on-add scan picks up its file", async () => {
    const h = await harness();
    const mediaRoot = mkdtempSync(join(dir, "media2-"));
    // Non-conventional folder name (movieFolderName would be "My Great Movie (1999)").
    const folder = "My_Great_Movie_(1999)";
    stageFile(join(mediaRoot, folder, "My.Great.Movie.1999.1080p.BluRay.mkv"));

    const created = await h.movies.create({
      title: "My Great Movie", releaseDate: "1999-05-01", rootFolderPath: mediaRoot, folderName: folder,
      monitored: true, minimumAvailability: "announced", tags: [],
    });
    // The on-add event handler calls exactly this; drive it explicitly for a deterministic test.
    const res = await h.scan.scanMovie(created.id);
    expect(res.filesFound).toBe(1);
    expect(res.filesAdded).toBe(1);

    const files = await h.db.select().from(schema.mediaFile).where(eq(schema.mediaFile.mediaId, created.id));
    expect(files).toHaveLength(1);
    // The file must be recorded under the override folder, not the conventional one.
    expect(files[0].relativePath).toBe(`${folder}/My.Great.Movie.1999.1080p.BluRay.mkv`);
    expect(files[0].relativePath.startsWith("My Great Movie")).toBe(false);
  });

  it("keeps conventional-noise behavior: a title without an override still scans its 'Title (Year)' folder", async () => {
    const h = await harness();
    const mediaRoot = mkdtempSync(join(dir, "media3-"));
    stageFile(join(mediaRoot, "Conventional Movie (2005)", "file.mkv"));
    const created = await h.movies.create({
      title: "Conventional Movie", releaseDate: "2005-06-01", rootFolderPath: mediaRoot,
      monitored: true, minimumAvailability: "announced", tags: [],
    });
    const res = await h.scan.scanMovie(created.id);
    expect(res.filesFound).toBe(1);
    expect(res.filesAdded).toBe(1);
    const files = await h.db.select().from(schema.mediaFile).where(eq(schema.mediaFile.mediaId, created.id));
    expect(files[0].relativePath).toBe("Conventional Movie (2005)/file.mkv");
  });

  it("honors an override when the series import target lives in a non-standard folder", async () => {
    const h = await harness();
    const mediaRoot = mkdtempSync(join(dir, "media4-"));
    const folder = "Breaking.Bad";
    stageFile(join(mediaRoot, folder, "Season 1", "Breaking.Bad.S01E01.1080p.WEB-DL.mkv"));
    const created = await h.series.create({
      title: "Breaking Bad", tvdbId: 1, tmdbId: 1, firstAirYear: 2008, rootFolderPath: mediaRoot, folderName: folder,
      monitored: true, seriesType: "standard", tags: [],
    });
    // series.create() auto-creates seasons 0 and 1 — reuse the auto-created season 1 rather
    // than inserting one (which collides on the season_series_num unique index).
    const season = (await h.db.select().from(schema.season)
      .where(and(eq(schema.season.seriesId, created.id), eq(schema.season.seasonNumber, 1))))[0];
    await h.db.insert(schema.episode).values([{
      id: "s1e1", seriesId: created.id, seasonId: season.id, episodeNumber: 1, absoluteNumber: null,
      title: "Pilot", overview: "", airDateUtc: null, monitored: true, hasFile: false,
      sceneSeasonNumber: null, sceneEpisodeNumber: null,
    }]);
    const res = await h.scan.scanSeries(created.id);
    const files = await h.db.select().from(schema.mediaFile).where(eq(schema.mediaFile.mediaId, created.id));
    expect(files).toHaveLength(1);
    expect(files[0].relativePath.startsWith(`${folder}/Season 1/`)).toBe(true);
    expect(res.filesAdded).toBeGreaterThan(0);
  });

  it("imports a series' files via the real add sequence (create -> metadata refresh -> scan-one)", async () => {
    const h = await harness();
    const mediaRoot = mkdtempSync(join(dir, "media5-"));
    const folder = "My.Show";
    stageFile(join(mediaRoot, folder, "Season 1", "My.Show.S01E01.1080p.WEB-DL.mkv"));

    // 1. Add the series with the folder-name override (the Library Import create step).
    const created = await h.series.create({
      title: "My Show", tvdbId: 1, tmdbId: 1, firstAirYear: 2020, rootFolderPath: mediaRoot, folderName: folder,
      monitored: true, seriesType: "standard", tags: [],
    });
    // (The on-add scan fired inside create() but no episodes existed yet, so it imported
    // nothing — exactly the gap this test guards.)

    // 2. Metadata refresh populates season 1 + episode 1 from the (faked) TMDB provider.
    const svc = new MetadataService(h.db, h.config, {} as never, {} as never, new AutoTagsService(h.db)) as MetadataService;
    (svc as unknown as { provider: () => Promise<unknown> }).provider = async () => ({
      tmdbIdForTvdb: async () => 900000,
      getDetails: async () => ({ title: "My Show", overview: "o", genres: [], images: [], year: 2020 }),
      seriesSeasons: async () => [{ season_number: 1, episodes: [{ episode_number: 1, name: "Pilot", overview: "", air_date: "2020-01-01" }] }],
    });
    (svc as unknown as { tvdbProvider: () => Promise<unknown> }).tvdbProvider = async () => ({
      episodes: async () => [], seriesAliases: async () => [],
    });
    const refreshed = await svc.refreshSeries(created.id);
    expect(refreshed.episodes).toBe(1);

    // 3. The Library Import add() now fires the explicit per-title scan the frontend calls
    // (POST /library-scan/series/:id) — no manual scanSeries call, matching the add action.
    const res = await h.scan.scanMedia("series", created.id);
    const files = await h.db.select().from(schema.mediaFile).where(eq(schema.mediaFile.mediaId, created.id));
    expect(files).toHaveLength(1);
    expect(files[0].relativePath.startsWith(`${folder}/Season 1/`)).toBe(true);
    expect(res.filesAdded).toBe(1);
  });
});
