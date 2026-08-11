// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@medianexus/database";
import { runImport } from "../src/import/importer";

let dir: string;
const targets: { handle: ReturnType<typeof createDb> }[] = [];

function newTarget(name: string) {
  const path = join(dir, name);
  const handle = createDb(path);
  handle.runMigrations();
  targets.push({ handle });
  return handle;
}

function mkSource(name: string, build: (db: Database.Database) => void): string {
  const path = join(dir, name);
  const db = new Database(path);
  db.exec("PRAGMA journal_mode=WAL");
  build(db);
  db.close();
  return path;
}

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "mn-import-")); });
afterAll(() => { for (const t of targets) t.handle.close(); process.exitCode = 0; });

describe("M7 import: sonarr", () => {
  let srcPath: string;
  beforeAll(async () => {
    srcPath = mkSource("sonarr.db", (db) => {
    db.exec(`CREATE TABLE Series (Id INTEGER PRIMARY KEY, Title TEXT, TvdbId INTEGER, Monitored INTEGER, QualityProfileId INTEGER, Path TEXT, SeriesType TEXT, Status TEXT, Added INTEGER, Overview TEXT, FirstAired INTEGER, Tags TEXT, Genres TEXT, Images TEXT);
      CREATE TABLE Seasons (Id INTEGER PRIMARY KEY, SeriesId INTEGER, SeasonNumber INTEGER, Monitored INTEGER);
      CREATE TABLE Episodes (Id INTEGER PRIMARY KEY, SeriesId INTEGER, SeasonNumber INTEGER, EpisodeNumber INTEGER, Title TEXT, AirDateUtc INTEGER, Monitored INTEGER, HasFile INTEGER);
      CREATE TABLE QualityProfiles (Id INTEGER PRIMARY KEY, Name TEXT, UpgradeAllowed INTEGER, Items TEXT, Cutoff INTEGER);
      CREATE TABLE History (Id INTEGER PRIMARY KEY, SeriesId INTEGER, EventType INTEGER, Date INTEGER, SourceTitle TEXT);
      CREATE TABLE Indexers (Id INTEGER PRIMARY KEY, Name TEXT, Implementation TEXT, Settings TEXT, Enable INTEGER, Protocol TEXT, Priority INTEGER, Tags TEXT);`);
    db.prepare(`INSERT INTO Series (Id,Title,TvdbId,Monitored,QualityProfileId,Path,SeriesType,Status,Added,Overview,FirstAired,Tags,Genres,Images) VALUES (1,'Imported Show',9001,1,1,'/media/show','standard','continuing',${Date.now()},'an overview',${Date.now()},'[]','[]','[]')`).run();
    db.prepare(`INSERT INTO QualityProfiles (Id,Name,UpgradeAllowed,Items,Cutoff) VALUES (1,'HD-1080p',1,'[]',0)`).run();
    db.prepare(`INSERT INTO Seasons (Id,SeriesId,SeasonNumber,Monitored) VALUES (1,1,1,1),(2,1,2,1)`).run();
    db.prepare(`INSERT INTO Episodes (Id,SeriesId,SeasonNumber,EpisodeNumber,Title,AirDateUtc,Monitored,HasFile) VALUES (1,1,1,1,'Pilot',${Date.now()},1,0),(2,1,2,1,'S2E1',${Date.now()},1,0)`).run();
    db.prepare(`INSERT INTO History (Id,SeriesId,EventType,Date,SourceTitle) VALUES (1,1,1,${Date.now()},'Imported.Show.S01E01')`).run();
    db.prepare(`INSERT INTO Indexers (Id,Name,Implementation,Settings,Enable,Protocol,Priority,Tags) VALUES (1,'nzbidx','newznab','{"baseUrl":"https://nzb.invalid","apiKey":"x"}',1,'usenet',25,'[]')`).run();
    });
  });

  it("maps series, seasons, episodes, profiles, history and indexers", async () => {
    const target = newTarget("t-sonarr.db");
    const report = await runImport(srcPath, target.db, { kind: "sonarr" });
    expect(report.series).toBe(1);
    expect(report.seasons).toBe(2);
    expect(report.episodes).toBe(2);
    expect(report.qualityProfiles).toBe(1);
    expect(report.history).toBe(1);
    expect(report.indexers).toBe(1);

    const seriesRow = (await target.db.select().from(schema.series).where(eq(schema.series.id, "imp_s1")))[0];
    expect(seriesRow.title).toBe("Imported Show");
    expect(seriesRow.tvdbId).toBe(9001);
    expect(seriesRow.monitored).toBe(true);

    const eps = await target.db.select().from(schema.episode).where(eq(schema.episode.seriesId, "imp_s1"));
    expect(eps.length).toBe(2);
    expect(eps.some((e: any) => e.title === "Pilot")).toBe(true);

    const hist = await target.db.select().from(schema.historyEntry).where(eq(schema.historyEntry.mediaId, "imp_s1"));
    expect(hist[0].action).toBe("grabbed");

    const idx = await target.db.select().from(schema.indexer);
    expect(idx[0].implementation).toBe("newznab");
    expect(idx[0].settings).toMatchObject({ baseUrl: "https://nzb.invalid" });
  });

  it("is idempotent on re-run", async () => {
    const target = newTarget("t-sonarr2.db");
    const first = await runImport(srcPath, target.db, { kind: "sonarr" });
    const second = await runImport(srcPath, target.db, { kind: "sonarr" });
    expect(second.series).toBe(0); // already present -> skipped
    expect(second.skipped).toBeGreaterThanOrEqual(first.series);
  });
});


describe("M7 import: radarr", () => {
  let srcPath: string;
  beforeAll(() => {
    srcPath = mkSource("radarr.db", (db) => {
    db.exec(`CREATE TABLE Movies (Id INTEGER PRIMARY KEY, Title TEXT, TmdbId INTEGER, Monitored INTEGER, QualityProfileId INTEGER, Path TEXT, Year INTEGER, Overview TEXT, Status TEXT, Tags TEXT, Images TEXT);
      CREATE TABLE QualityProfiles (Id INTEGER PRIMARY KEY, Name TEXT, UpgradeAllowed INTEGER, Items TEXT, Cutoff INTEGER);
      CREATE TABLE History (Id INTEGER PRIMARY KEY, MovieId INTEGER, EventType INTEGER, Date INTEGER, SourceTitle TEXT);`);
    db.prepare(`INSERT INTO Movies (Id,Title,TmdbId,Monitored,QualityProfileId,Path,Year,Overview,Status,Tags,Images) VALUES (1,'Imported Movie',7001,1,1,'/media/movie',2022,'mov overview','released','[]','[]')`).run();
    db.prepare(`INSERT INTO QualityProfiles (Id,Name,UpgradeAllowed,Items,Cutoff) VALUES (1,'HD',1,'[]',0)`).run();
    db.prepare(`INSERT INTO History (Id,MovieId,EventType,Date,SourceTitle) VALUES (1,1,1,${Date.now()},'Imported.Movie.2022')`).run();
    });
  });

  it("maps movies + profiles + history", async () => {
    const target = newTarget("t-radarr.db");
    const report = await runImport(srcPath, target.db, { kind: "radarr" });
    expect(report.movies).toBe(1);
    expect(report.qualityProfiles).toBe(1);
    expect(report.history).toBe(1);
    const m = (await target.db.select().from(schema.movie).where(eq(schema.movie.id, "imp_m1")))[0];
    expect(m.title).toBe("Imported Movie");
    expect(m.tmdbId).toBe(7001);
  });
});

describe("M7 import: prowlarr", () => {
  let srcPath: string;
  beforeAll(() => {
    srcPath = mkSource("prowlarr.db", (db) => {
    db.exec(`CREATE TABLE Indexers (Id INTEGER PRIMARY KEY, Name TEXT, Implementation TEXT, Settings TEXT, Enable INTEGER, Protocol TEXT, Priority INTEGER, Tags TEXT);
      CREATE TABLE Tags (Id INTEGER PRIMARY KEY, Label TEXT);`);
    db.prepare(`INSERT INTO Indexers (Id,Name,Implementation,Settings,Enable,Protocol,Priority,Tags) VALUES (1,'torznab','torznab','{"baseUrl":"https://tracker.invalid"}',1,'torrent',25,'[1]')`).run();
    db.prepare(`INSERT INTO Tags (Id,Label) VALUES (1,'movies')`).run();
    });
  });

  it("maps indexers", async () => {
    const target = newTarget("t-prowlarr.db");
    const report = await runImport(srcPath, target.db, { kind: "prowlarr" });
    expect(report.indexers).toBe(1);
    const i = (await target.db.select().from(schema.indexer).where(eq(schema.indexer.id, "imp_idx1")))[0];
    expect(i.protocol).toBe("torrent");
    expect(i.settings).toMatchObject({ baseUrl: "https://tracker.invalid" });
  });
});

describe("M7 import: seerr", () => {
  let srcPath: string;
  beforeAll(() => {
    srcPath = mkSource("overseerr.db", (db) => {
    db.exec(`CREATE TABLE User (id INTEGER PRIMARY KEY, username TEXT, email TEXT, plexUsername TEXT);
      CREATE TABLE Media (id INTEGER PRIMARY KEY, tmdbId INTEGER, tvdbId INTEGER, mediaType TEXT, status TEXT);
      CREATE TABLE MediaRequest (id INTEGER PRIMARY KEY, mediaId INTEGER, type TEXT, status INTEGER, requestedBy INTEGER, createdAt INTEGER);
      CREATE TABLE Watchlist (userId INTEGER, tmdbId INTEGER, mediaType TEXT);`);
    db.prepare(`INSERT INTO User (id,username,email) VALUES (1,'seeduser','s@e.com')`).run();
    db.prepare(`INSERT INTO Media (id,tmdbId,mediaType,status) VALUES (1,7101,'movie','pending')`).run();
    db.prepare(`INSERT INTO MediaRequest (id,mediaId,type,status,requestedBy,createdAt) VALUES (1,1,'movie',1,1,${Date.now()})`).run();
    db.prepare(`INSERT INTO Watchlist (userId,tmdbId,mediaType) VALUES (1,7101,'movie')`).run();
    });
  });

  it("maps users, requests and watchlist against existing native media", async () => {
    const target = newTarget("t-seerr.db");
    // the seerr media maps to an existing native movie by tmdbId
    await target.db.insert(schema.movie).values({ id: "native-7101", tmdbId: 7101, title: "Existing", monitored: true, addedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const report = await runImport(srcPath, target.db, { kind: "seerr" });
    expect(report.users).toBe(1);
    expect(report.requests).toBe(1);
    const req = (await target.db.select().from(schema.request).where(eq(schema.request.id, "imp_seerr_r1")))[0];
    expect(req.mediaId).toBe("native-7101");
    expect(req.status).toBe("pending");
    const watch = await target.db.select().from(schema.watchlist);
    expect(watch.length).toBe(1);
    expect(watch[0].mediaId).toBe("native-7101");
    const avail = await target.db.select().from(schema.mediaAvailability);
    expect(avail.length).toBeGreaterThanOrEqual(1);
  });
});
