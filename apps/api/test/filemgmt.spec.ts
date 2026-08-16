// SPDX-License-Identifier: MIT
/**
 * FILEMGMT-1 (gap report C7) regression coverage for the new file-management surface:
 *   - MediaFilesService: DELETE /media-files/:id (dispose + remove row, 404 when absent) and
 *     PUT /media-files/:id (metadata-only partial update).
 *   - Title delete-with-files: MoviesService.remove/SeriesService.remove with
 *     { deleteFiles, addImportExclusion } — opt-in disk + list-exclusion deletion.
 *   - Rename execute: POST /movies|series/:id/rename moves real files on disk and updates the
 *     DB row, only for the requested ids.
 * Tests that touch disk use real scratch temp dirs (no mocked fs), per project convention.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "@medianexus/events";
import { RecycleBinService } from "../src/media/recycle-bin.service";
import { createDb, schema, type Db } from "@medianexus/database";
import { ConfigService } from "../src/system/config.service";
import { EventsService } from "../src/events/events.service";
import { AutoTagsService } from "../src/auto-tags/auto-tags.service";
import { MoviesService } from "../src/movies/movies.service";
import { SeriesService } from "../src/series/series.service";
import { MediaFilesService } from "../src/media/media-files.service";

const dir = mkdtempSync(join(tmpdir(), "mn-filemgmt-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });

let counter = 0;
function freshDb(): Db {
  const handle = createDb(join(dir, `fm-${counter++}.db`));
  handle.runMigrations();
  handles.push(handle);
  return handle.db;
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

async function seedMovie(db: Db, rootRoot: string) {
  const now = new Date().toISOString();
  await db.insert(schema.movie).values({
    id: "m1", tmdbId: 1, imdbId: null, title: "Fight Club", originalTitle: null, overview: "",
    status: "released", releaseDate: "1999-10-15", monitored: true, qualityProfileId: null,
    rootFolderPath: rootRoot, minimumAvailability: "released", genres: [], images: [], tags: [],
    hasFile: true, addedAt: now, updatedAt: now,
  });
}

const movieFolder = (root: string) => join(root, "Fight Club (1999)");

async function seedSeries(db: Db, rootRoot: string) {
  const now = new Date().toISOString();
  await db.insert(schema.series).values({
    id: "s1", tvdbId: 1, tmdbId: null, imdbId: null, title: "Game of Thrones", overview: "",
    status: "ended", seriesType: "standard", network: null, firstAirYear: 2011,
    monitored: true, qualityProfileId: null, rootFolderPath: rootRoot, genres: [], images: [],
    tags: [], alternateTitles: [], addedAt: now, updatedAt: now,
  });
  await db.insert(schema.season).values([{ id: "sea1", seriesId: "s1", seasonNumber: 1, monitored: true }]);
  await db.insert(schema.episode).values([{
    id: "s1e1", seriesId: "s1", seasonId: "sea1", episodeNumber: 1, absoluteNumber: null,
    title: "Winter Is Coming", overview: "", airDateUtc: null, monitored: true, hasFile: false,
    sceneSeasonNumber: null, sceneEpisodeNumber: null,
  }]);
}

/** A recycling bin that records every dispose() path instead of touching disk — lets us assert
 *  the exact absolute path the service derived without needing a filesystem move. */
function recordingRecycleBin() {
  const disposed: string[] = [];
  return {
    disposed,
    dispose: async (p: string) => { disposed.push(p); },
  } as unknown as RecycleBinService;
}

/** A real recycling bin backed by a scratch dir (no recycleBinPath config → deletes outright). */
function realRecycleBin(db: Db) {
  return new RecycleBinService(new ConfigService(db));
}

describe("FILEMGMT-1 — MediaFilesService (DELETE/PUT media-files/:id)", () => {
  it("DELETE disposes the physical file with the resolved path and removes the row; 404 when absent", async () => {
    const db = freshDb();
    const root = join(dir, `root-mf-${counter}`);
    await mkdir(join(root, "Fight Club (1999)"), { recursive: true });
    const rel = "Fight Club (1999)/Fight Club (1999).mkv";
    await writeFile(join(root, rel), "x");
    await seedMovie(db, root);
    await db.insert(schema.mediaFile).values({
      id: "mf1", mediaType: "movie", mediaId: "m1", episodeIds: [], relativePath: rel,
      size: 1, quality: { source: "bluray", resolution: "1080p", edition: "" }, dateAdded: new Date().toISOString(),
    });

    const bin = recordingRecycleBin();
    const mediaFiles = new MediaFilesService(db, bin);
    const res = await mediaFiles.remove("mf1");
    expect(res).toEqual({ removed: true });
    // Dispose must be called with the owning title's folder + relativePath resolved.
    expect(bin.disposed).toEqual([join(root, rel)]);
    // Row gone.
    const rows = db.select().from(schema.mediaFile).all();
    expect(rows.length).toBe(0);
    await expect(mediaFiles.remove("mf1")).rejects.toThrow();
  });

  it("PUT updates only the provided fields (partial update leaves the rest untouched)", async () => {
    const db = freshDb();
    await seedMovie(db, join(dir, `root-put-${counter}`));
    await db.insert(schema.mediaFile).values({
      id: "mf2", mediaType: "movie", mediaId: "m1", episodeIds: [], relativePath: "Fight Club (1999)/Fight Club (1999).mkv",
      size: 5, quality: { source: "bluray", resolution: "1080p", edition: "" }, dateAdded: new Date().toISOString(), languages: ["en"],
      releaseGroup: null,
    });
    const mediaFiles = new MediaFilesService(db, recordingRecycleBin());
    const updated = await mediaFiles.update("mf2", { releaseGroup: "FGT" });
    expect(updated.releaseGroup).toBe("FGT");
    expect(updated.quality).toEqual({ source: "bluray", resolution: "1080p", edition: "" });
    expect(updated.languages).toEqual(["en"]);
    expect(updated.relativePath).toBe("Fight Club (1999)/Fight Club (1999).mkv");
    // releaseGroup can be cleared to null.
    const cleared = await mediaFiles.update("mf2", { releaseGroup: null });
    expect(cleared.releaseGroup).toBeNull();
  });
});

describe("FILEMGMT-1 — title delete-with-files + opt-in import exclusion (movies/series)", () => {
  it("movie: deleteFiles=true removes the real file and the title folder from disk", async () => {
    const db = freshDb();
    const root = join(dir, `root-del1-${counter}`);
    const folder = movieFolder(root);
    await mkdir(folder, { recursive: true });
    const rel = "Fight Club (1999)/Fight Club (1999).mkv";
    await writeFile(join(root, rel), "x");
    await seedMovie(db, root);
    await db.insert(schema.mediaFile).values({
      id: "mf3", mediaType: "movie", mediaId: "m1", episodeIds: [], relativePath: rel, size: 1,
      quality: { source: "bluray", resolution: "1080p", edition: "" }, dateAdded: new Date().toISOString(),
    });

    const movies = new MoviesService(db, new EventsService(new EventBus()), new AutoTagsService(db), new ConfigService(db), undefined as never, realRecycleBin(db));
    expect(await exists(join(root, rel))).toBe(true);
    await movies.remove("m1", { deleteFiles: true });
    expect(await exists(join(root, rel))).toBe(false);
    expect(await exists(folder)).toBe(false);
    // Movie row (and its polymorphic rows) gone.
    expect(db.select().from(schema.movie).all().length).toBe(0);
    expect(db.select().from(schema.mediaFile).all().length).toBe(0);
  });

  it("movie: deleteFiles=false (bare delete) leaves files and folder untouched (today's behavior)", async () => {
    const db = freshDb();
    const root = join(dir, `root-del2-${counter}`);
    const folder = movieFolder(root);
    await mkdir(folder, { recursive: true });
    const rel = "Fight Club (1999)/Fight Club (1999).mkv";
    await writeFile(join(root, rel), "x");
    await seedMovie(db, root);
    await db.insert(schema.mediaFile).values({
      id: "mf4", mediaType: "movie", mediaId: "m1", episodeIds: [], relativePath: rel, size: 1,
      quality: { source: "bluray", resolution: "1080p", edition: "" }, dateAdded: new Date().toISOString(),
    });

    const movies = new MoviesService(db, new EventsService(new EventBus()), new AutoTagsService(db), new ConfigService(db), undefined as never, realRecycleBin(db));
    await movies.remove("m1"); // no body
    expect(await exists(join(root, rel))).toBe(true);
    expect(await exists(folder)).toBe(true);
    expect(db.select().from(schema.movie).all().length).toBe(0);
  });

  it("series: deleteFiles=true removes the title folder recursively", async () => {
    const db = freshDb();
    const root = join(dir, `root-sdel-${counter}`);
    const folder = join(root, "Game of Thrones", "Season 1");
    await mkdir(folder, { recursive: true });
    const rel = "Game of Thrones/Season 1/Game of Thrones - S01E01 - Winter Is Coming.mkv";
    await writeFile(join(root, rel), "x");
    await seedSeries(db, root);
    await db.insert(schema.mediaFile).values({
      id: "mf5", mediaType: "series", mediaId: "s1", episodeIds: ["s1e1"], relativePath: rel,
      size: 1, quality: { source: "web", resolution: "1080p", edition: "" }, dateAdded: new Date().toISOString(),
    });

    const series = new SeriesService(db, new EventsService(new EventBus()), new AutoTagsService(db), new ConfigService(db), undefined as never, realRecycleBin(db));
    await series.remove("s1", { deleteFiles: true });
    expect(await exists(folder)).toBe(false);
    expect(db.select().from(schema.mediaFile).all().length).toBe(0);
  });

  it("addImportExclusion gates the import_exclusion insert (true creates, default does not)", async () => {
    const db = freshDb();
    await seedMovie(db, join(dir, `root-exc-${counter}`));
    const events = new EventsService(new EventBus());
    const movies = new MoviesService(db, events, new AutoTagsService(db), new ConfigService(db), undefined as never, realRecycleBin(db));

    // Default (no body): no exclusion row.
    await movies.remove("m1");
    const excAll = db.select().from(schema.importExclusion).all();
    expect(excAll.length).toBe(0);

    // addImportExclusion=true: creates the exclusion row for the movie's tmdbId.
    await seedMovie2(db, "m2");
    await movies.remove("m2", { addImportExclusion: true });
    const exclusions = db.select().from(schema.importExclusion).all();
    expect(exclusions.length).toBe(1);
    expect(exclusions[0]).toMatchObject({ mediaType: "movie", externalId: "2", reason: "removed from library" });
  });
});

describe("FILEMGMT-1 — rename execute (POST /movies|series/:id/rename)", () => {
  it("movie: moves the real file on disk, updates relativePath, and only touches requested files", async () => {
    const db = freshDb();
    const config = new ConfigService(db);
    const root = join(dir, `root-ren-${counter}`);
    const folder = movieFolder(root);
    await mkdir(folder, { recursive: true });
    const oldRel = "Fight Club (1999)/Old Name.mkv";
    await writeFile(join(root, oldRel), "x");
    await seedMovie(db, root);
    await db.insert(schema.mediaFile).values([
      { id: "mf_r1", mediaType: "movie", mediaId: "m1", episodeIds: [], relativePath: oldRel, size: 1, quality: { source: "bluray", resolution: "1080p", edition: "" }, dateAdded: new Date().toISOString() },
      { id: "mf_r2", mediaType: "movie", mediaId: "m1", episodeIds: [], relativePath: "Fight Club (1999)/Untouched MKV.mkv", size: 1, quality: { source: "bluray", resolution: "1080p", edition: "" }, dateAdded: new Date().toISOString() },
    ]);
    await writeFile(join(root, "Fight Club (1999)/Untouched MKV.mkv"), "x");
    // Drop the year from the movie template so the requested file would rename.
    await config.upsert({ "media.naming": { movies: "{Movie Title}" } } as never);

    const movies = new MoviesService(db, new EventsService(new EventBus()), new AutoTagsService(db), config, undefined as never, realRecycleBin(db));
    const res = await movies.rename("m1", ["mf_r1"]);
    expect(res.renamed).toBe(1);
    expect(res.results).toEqual([{ mediaFileId: "mf_r1", renamed: true }]);
    expect(await exists(join(root, oldRel))).toBe(false);
    expect(await exists(join(root, "Fight Club (1999)/Fight Club.mkv"))).toBe(true);
    const rows = db.select().from(schema.mediaFile).all().sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(rows[0].relativePath).toBe("Fight Club (1999)/Fight Club.mkv"); // renamed
    expect(rows[1].relativePath).toBe("Fight Club (1999)/Untouched MKV.mkv"); // not in request -> untouched
    expect(await exists(join(root, "Fight Club (1999)/Untouched MKV.mkv"))).toBe(true);
  });

  it("series: moves the real file to the template-derived path and updates the row", async () => {
    const db = freshDb();
    const config = new ConfigService(db);
    const root = join(dir, `root-sren-${counter}`);
    const folder = join(root, "Game of Thrones", "Season 1");
    await mkdir(folder, { recursive: true });
    const oldRel = "Game of Thrones/Season 1/Old S01E01.mkv";
    await writeFile(join(root, oldRel), "x");
    await seedSeries(db, root);
    await db.insert(schema.mediaFile).values({
      id: "mf_sr1", mediaType: "series", mediaId: "s1", episodeIds: ["s1e1"], relativePath: oldRel,
      size: 1, quality: { source: "web", resolution: "1080p", edition: "" }, dateAdded: new Date().toISOString(),
    });
    await config.upsert({ "media.naming": { episodes: "{Series Title} S{season:00}E{episode:00}" } } as never);

    const series = new SeriesService(db, new EventsService(new EventBus()), new AutoTagsService(db), config, undefined as never, realRecycleBin(db));
    const res = await series.rename("s1", ["mf_sr1"]);
    expect(res.renamed).toBe(1);
    const newRel = "Game of Thrones/Season 1/Game of Thrones S01E01.mkv";
    expect(await exists(join(root, oldRel))).toBe(false);
    expect(await exists(join(root, newRel))).toBe(true);
    expect(db.select().from(schema.mediaFile).all()[0].relativePath).toBe(newRel);
  });
});

// A second movie with a distinct tmdbId for the exclusion test above.
async function seedMovie2(db: Db, id: string) {
  const now = new Date().toISOString();
  await db.insert(schema.movie).values({
    id, tmdbId: 2, imdbId: null, title: "Seven", originalTitle: null, overview: "",
    status: "released", releaseDate: "1995-09-22", monitored: true, qualityProfileId: null,
    rootFolderPath: "", minimumAvailability: "released", genres: [], images: [], tags: [],
    hasFile: false, addedAt: now, updatedAt: now,
  });
}
