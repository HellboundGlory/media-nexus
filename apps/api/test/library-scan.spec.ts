// SPDX-License-Identifier: MIT
/**
 * Roadmap P0.6 (gap report B3): before this, the app only knew about files it imported
 * itself. Point it at an existing library — including one brought across by the upstream
 * DB importer, which writes series/episode/movie rows but zero media_file rows — and every
 * title reads as missing forever. This covers LibraryScanService reconciling files already
 * sitting on disk against already-added titles, scoped to their own rootFolderPath (see the
 * scoping note in the service's own file header for why this doesn't browse for new titles).
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { EventBus } from "@medianexus/events";
import { createDb, schema } from "@medianexus/database";
import { LibraryScanService } from "../src/library-scan/library-scan.service";
import { MediaRepository } from "../src/media/media.repository";
import { EventsService } from "../src/events/events.service";
import { movieFolderName, seriesFolderName } from "../src/media/naming.helpers";
import { runImport } from "../src/upstream-import/importer";

const dir = mkdtempSync(join(tmpdir(), "mn-scan-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });

let counter = 0;
async function harness() {
  const id = `scan-${counter++}`;
  const handle = createDb(join(dir, `${id}.db`));
  handle.runMigrations();
  handles.push(handle);
  const mediaRoot = join(dir, id, "media");
  mkdirSync(mediaRoot, { recursive: true });
  const events = new EventsService(new EventBus());
  const scan = new LibraryScanService(handle.db, new MediaRepository(handle.db), events);
  return { db: handle.db, scan, events, mediaRoot };
}

function stageFile(path: string, size = 2048) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, Buffer.alloc(size));
}

async function seedMovie(db: Awaited<ReturnType<typeof harness>>["db"], mediaRoot: string, over: Partial<typeof schema.movie.$inferInsert> = {}) {
  const now = new Date().toISOString();
  await db.insert(schema.movie).values({
    id: "m1", tmdbId: 1, title: "Scan Movie", overview: "", status: "released", releaseDate: "2021-05-01",
    monitored: true, qualityProfileId: null, rootFolderPath: mediaRoot, minimumAvailability: "announced",
    genres: [], images: [], tags: [], hasFile: false, addedAt: now, updatedAt: now,
    ...over,
  });
}

async function seedSeries(db: Awaited<ReturnType<typeof harness>>["db"], mediaRoot: string) {
  const now = new Date().toISOString();
  await db.insert(schema.series).values({
    id: "s1", tvdbId: 1, tmdbId: null, imdbId: null, title: "Scan Show", overview: "",
    status: "continuing", seriesType: "standard", network: null, firstAirYear: 2020,
    monitored: true, qualityProfileId: null, rootFolderPath: mediaRoot,
    genres: [], images: [], tags: [], addedAt: now, updatedAt: now,
  });
  await db.insert(schema.season).values([{ id: "sea1", seriesId: "s1", seasonNumber: 1, monitored: true }]);
  await db.insert(schema.episode).values([
    { id: "s1e1", seriesId: "s1", seasonId: "sea1", episodeNumber: 1, absoluteNumber: null, title: "", overview: "", airDateUtc: null, monitored: true, hasFile: false, sceneSeasonNumber: null, sceneEpisodeNumber: null },
    { id: "s1e2", seriesId: "s1", seasonId: "sea1", episodeNumber: 2, absoluteNumber: null, title: "", overview: "", airDateUtc: null, monitored: true, hasFile: false, sceneSeasonNumber: null, sceneEpisodeNumber: null },
  ]);
}

describe("LibraryScanService — movie", () => {
  it("picks up a file already sitting in the movie's folder", async () => {
    const h = await harness();
    await seedMovie(h.db, h.mediaRoot);
    const folder = join(h.mediaRoot, movieFolderName("Scan Movie", "2021-05-01"));
    stageFile(join(folder, "Scan Movie (2021) 1080p BluRay.mkv"));

    const result = await h.scan.scanMovie("m1");
    expect(result.filesAdded).toBe(1);

    const movie = (await h.db.select().from(schema.movie).where(eq(schema.movie.id, "m1")))[0];
    expect(movie.hasFile).toBe(true);
    const files = await h.db.select().from(schema.mediaFile).where(eq(schema.mediaFile.mediaId, "m1"));
    expect(files).toHaveLength(1);
    expect(files[0].quality).toEqual({ source: "bluray", resolution: "1080p", edition: "" });
  });

  it("re-scanning an already-tracked movie is a no-op", async () => {
    const h = await harness();
    await seedMovie(h.db, h.mediaRoot);
    const folder = join(h.mediaRoot, movieFolderName("Scan Movie", "2021-05-01"));
    stageFile(join(folder, "Scan Movie (2021) 1080p BluRay.mkv"));

    await h.scan.scanMovie("m1");
    const second = await h.scan.scanMovie("m1");
    expect(second.filesAdded).toBe(0);
    const files = await h.db.select().from(schema.mediaFile).where(eq(schema.mediaFile.mediaId, "m1"));
    expect(files).toHaveLength(1); // still just one row, not duplicated
  });

  it("clears hasFile once the tracked file is deleted from disk outside the app", async () => {
    const h = await harness();
    await seedMovie(h.db, h.mediaRoot);
    const folder = join(h.mediaRoot, movieFolderName("Scan Movie", "2021-05-01"));
    const filePath = join(folder, "Scan Movie (2021) 1080p BluRay.mkv");
    stageFile(filePath);
    await h.scan.scanMovie("m1");

    rmSync(filePath); // simulate a user deleting the file outside the app
    const result = await h.scan.scanMovie("m1");
    expect(result.filesRemoved).toBe(1);

    const movie = (await h.db.select().from(schema.movie).where(eq(schema.movie.id, "m1")))[0];
    expect(movie.hasFile).toBe(false);
    const files = await h.db.select().from(schema.mediaFile).where(eq(schema.mediaFile.mediaId, "m1"));
    expect(files).toHaveLength(0);
  });
});

describe("LibraryScanService — series", () => {
  it("matches files to the right episodes and sets hasFile", async () => {
    const h = await harness();
    await seedSeries(h.db, h.mediaRoot);
    const seasonDir = join(h.mediaRoot, seriesFolderName("Scan Show"), "Season 1");
    stageFile(join(seasonDir, "Scan.Show.S01E01.1080p.WEB-DL.mkv"));
    stageFile(join(seasonDir, "Scan.Show.S01E02.1080p.WEB-DL.mkv"));

    const result = await h.scan.scanSeries("s1");
    expect(result.filesAdded).toBe(2);

    const episodes = await h.db.select().from(schema.episode).where(eq(schema.episode.seriesId, "s1"));
    expect(episodes.every((e) => e.hasFile)).toBe(true);
  });

  it("clears hasFile for an episode whose file vanished, leaving the other episode alone", async () => {
    const h = await harness();
    await seedSeries(h.db, h.mediaRoot);
    const seasonDir = join(h.mediaRoot, seriesFolderName("Scan Show"), "Season 1");
    const ep1Path = join(seasonDir, "Scan.Show.S01E01.1080p.WEB-DL.mkv");
    stageFile(ep1Path);
    stageFile(join(seasonDir, "Scan.Show.S01E02.1080p.WEB-DL.mkv"));
    await h.scan.scanSeries("s1");

    rmSync(ep1Path);
    await h.scan.scanSeries("s1");

    const ep1 = (await h.db.select().from(schema.episode).where(eq(schema.episode.id, "s1e1")))[0];
    const ep2 = (await h.db.select().from(schema.episode).where(eq(schema.episode.id, "s1e2")))[0];
    expect(ep1.hasFile).toBe(false);
    expect(ep2.hasFile).toBe(true);
  });

  it("re-scanning an already-tracked series is a no-op", async () => {
    const h = await harness();
    await seedSeries(h.db, h.mediaRoot);
    const seasonDir = join(h.mediaRoot, seriesFolderName("Scan Show"), "Season 1");
    stageFile(join(seasonDir, "Scan.Show.S01E01.1080p.WEB-DL.mkv"));

    await h.scan.scanSeries("s1");
    const second = await h.scan.scanSeries("s1");
    expect(second.filesAdded).toBe(0);
    const files = await h.db.select().from(schema.mediaFile).where(eq(schema.mediaFile.mediaId, "s1"));
    expect(files).toHaveLength(1);
  });
});

describe("LibraryScanService — on-add", () => {
  it("automatically scans a newly-added movie whose file is already on disk", async () => {
    const h = await harness();
    h.scan.onModuleInit();
    const folder = join(h.mediaRoot, movieFolderName("Scan Movie", "2021-05-01"));
    stageFile(join(folder, "Scan Movie (2021) 1080p BluRay.mkv"));

    await seedMovie(h.db, h.mediaRoot);
    h.events.publish("media.movie.added", { movieId: "m1", title: "Scan Movie" });
    await new Promise((r) => setTimeout(r, 20)); // async event handler

    const files = await h.db.select().from(schema.mediaFile).where(eq(schema.mediaFile.mediaId, "m1"));
    expect(files).toHaveLength(1);
  });
});

describe("LibraryScanService — closes the upstream-importer gap (gap report B3's own scenario)", () => {
  it("finds files for a series brought across by the upstream DB importer", async () => {
    const h = await harness();
    const seriesRoot = join(h.mediaRoot, "imported-series");
    mkdirSync(seriesRoot, { recursive: true });

    const srcPath = join(dir, `upstream-src-${counter++}.db`);
    const src = new Database(srcPath);
    src.exec("PRAGMA journal_mode=WAL");
    src.exec(`CREATE TABLE Series (Id INTEGER PRIMARY KEY, Title TEXT, TvdbId INTEGER, Monitored INTEGER, QualityProfileId INTEGER, Path TEXT, SeriesType TEXT, Status TEXT, Added INTEGER, Overview TEXT, FirstAired INTEGER, Tags TEXT, Genres TEXT, Images TEXT);
      CREATE TABLE Seasons (Id INTEGER PRIMARY KEY, SeriesId INTEGER, SeasonNumber INTEGER, Monitored INTEGER);
      CREATE TABLE Episodes (Id INTEGER PRIMARY KEY, SeriesId INTEGER, SeasonNumber INTEGER, EpisodeNumber INTEGER, Title TEXT, AirDateUtc INTEGER, Monitored INTEGER, HasFile INTEGER);
      CREATE TABLE QualityProfiles (Id INTEGER PRIMARY KEY, Name TEXT, UpgradeAllowed INTEGER, Items TEXT, Cutoff INTEGER);
      CREATE TABLE History (Id INTEGER PRIMARY KEY, SeriesId INTEGER, EventType INTEGER, Date INTEGER, SourceTitle TEXT);
      CREATE TABLE Indexers (Id INTEGER PRIMARY KEY, Name TEXT, Implementation TEXT, Settings TEXT, Enable INTEGER, Protocol TEXT, Priority INTEGER, Tags TEXT);`);
    src.prepare(`INSERT INTO Series (Id,Title,TvdbId,Monitored,QualityProfileId,Path,SeriesType,Status,Added,Overview,FirstAired,Tags,Genres,Images) VALUES (1,'Migrated Show',9001,1,1,'${seriesRoot.replace(/'/g, "''")}','standard','continuing',${Date.now()},'',${Date.now()},'[]','[]','[]')`).run();
    src.prepare(`INSERT INTO Seasons (Id,SeriesId,SeasonNumber,Monitored) VALUES (1,1,1,1)`).run();
    src.prepare(`INSERT INTO Episodes (Id,SeriesId,SeasonNumber,EpisodeNumber,Title,AirDateUtc,Monitored,HasFile) VALUES (1,1,1,1,'Pilot',${Date.now()},1,0)`).run();
    src.close();

    const report = await runImport(srcPath, h.db, { kind: "sonarr" });
    expect(report.series).toBe(1);

    // Confirmed by the gap report: the upstream importer writes zero media_file rows —
    // every episode reads as missing until a scan runs.
    const importedSeries = (await h.db.select().from(schema.series).where(eq(schema.series.tvdbId, 9001)))[0];
    const preScanEpisodes = await h.db.select().from(schema.episode).where(eq(schema.episode.seriesId, importedSeries.id));
    expect(preScanEpisodes.every((e) => !e.hasFile)).toBe(true);
    expect(await h.db.select().from(schema.mediaFile)).toHaveLength(0);

    // The user's existing library file, already on disk, using the same folder convention.
    const seasonDir = join(seriesRoot, seriesFolderName("Migrated Show"), "Season 1");
    stageFile(join(seasonDir, "Migrated.Show.S01E01.1080p.WEB-DL.mkv"));

    const result = await h.scan.scanSeries(importedSeries.id);
    expect(result.filesAdded).toBe(1);

    const postScanEpisodes = await h.db.select().from(schema.episode).where(eq(schema.episode.seriesId, importedSeries.id));
    expect(postScanEpisodes.find((e) => e.episodeNumber === 1)?.hasFile).toBe(true);
    expect(existsSync(seasonDir)).toBe(true);
  });
});
