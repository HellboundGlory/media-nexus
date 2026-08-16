// SPDX-License-Identifier: MIT
/**
 * Roadmap P0.7 (gap report I9): before this, every multi-write sequence in the app
 * (grab, import-apply, disk-scan reconciliation, title delete) ran as independently
 * awaited drizzle calls with no transaction — a crash or thrown error partway through
 * left whatever had already landed, with nothing to detect or repair it.
 *
 * This covers the acceptance criterion the roadmap itself specifies: force a failure
 * partway through a real multi-write sequence and assert that NONE of the writes in
 * that sequence landed — not just that an error was thrown. Each test opens its own
 * raw better-sqlite3 handle (rather than going through `createDb()`, which doesn't
 * expose it) so it can spy on `Database.prototype.prepare` and throw for one specific
 * statement, deterministically simulating "the Nth write in this transaction fails"
 * without needing to fabricate a real constraint violation.
 */
import { AutoTagsService } from "../src/auto-tags/auto-tags.service";
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { MIGRATIONS_DIR, schema, type Db } from "@medianexus/database";
import { EventBus } from "@medianexus/events";
import type { Release, Decision } from "@medianexus/domain";
import { IndexersService } from "../src/indexers/indexers.service";
import { AcquisitionService } from "../src/acquisition/acquisition.service";
import { MediaRepository } from "../src/media/media.repository";
import { ConfigService } from "../src/system/config.service";
import { EventsService } from "../src/events/events.service";
import { BlocklistService } from "../src/blocklist/blocklist.service";
import { RootFoldersService } from "../src/root-folders/root-folders.service";
import { RemotePathMappingsService } from "../src/remote-path-mappings/remote-path-mappings.service";
import { RecycleBinService } from "../src/media/recycle-bin.service";
import { MoviesService } from "../src/movies/movies.service";
import { SeriesService } from "../src/series/series.service";
import type { DecisionService } from "../src/decision/decision.service";
import type { ProvidersService } from "../src/providers/demo.providers";
import { ProviderStatusService } from "../src/providers/provider-status.service";
import type { ClientQueueItem } from "@medianexus/integrations";

const dir = mkdtempSync(join(tmpdir(), "mn-txn-"));
const openHandles: Database.Database[] = [];
afterEach(() => { for (const h of openHandles.splice(0)) h.close(); });

/** Same setup as connection.ts's createDb(), but keeps a reference to the raw
 *  better-sqlite3 handle so a test can spy on `.prepare()`. */
function openDb(path: string): { db: Db; sqlite: Database.Database } {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema }) as Db;
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  openHandles.push(sqlite);
  return { db, sqlite };
}

/** Make the raw handle throw the next time it's asked to prepare a statement whose SQL
 *  text contains `marker` — simulating "this specific write in the transaction fails"
 *  without needing a real constraint violation to trigger it. */
function throwOnPrepare(sqlite: Database.Database, marker: string, message: string): void {
  const real = sqlite.prepare.bind(sqlite);
  vi.spyOn(sqlite, "prepare").mockImplementation((sql: string) => {
    if (sql.includes(marker)) throw new Error(message);
    return real(sql);
  });
}

function release(over: Partial<Release> = {}): Release {
  return {
    id: "r1", indexerId: "idx1", indexerName: "Demo", title: "Some.Movie.2020.1080p.WEB-DL",
    protocol: "torrent", categories: [], size: 1000, ageHours: 1, seeders: 10, leechers: 1,
    quality: { source: "web", resolution: "1080p", edition: "" },
    isFreeleech: false, isProper: false, isRepack: false,
    ...over,
  };
}

describe("IndexersService.grab() is transactional", () => {
  it("rolls back the queue-entry insert when the history insert fails", async () => {
    const { db, sqlite } = openDb(join(dir, "grab.db"));
    const events = new EventsService(new EventBus());
    const config = new ConfigService(db);
    const providers = {
      pickDownloadClient: async () => ({ row: null, provider: { addRelease: async () => ({ downloadId: "d1" }) } }),
    } as unknown as ProvidersService;
    const decisions = {
      evaluate: async (_mt: string, _mid: string, r: Release) => ({ release: r, approved: true, profile: null, rejections: [] }) as Decision,
    } as unknown as DecisionService;
    const status = new ProviderStatusService(db, config);
    const svc = new IndexersService(db, providers, events, config, decisions, status);

    // The transaction writes download_queue_entry first, then history_entry second — fail
    // the second write and confirm the first (which had already executed its own INSERT
    // successfully, statement-wise) does not survive.
    throwOnPrepare(sqlite, 'into "history_entry"', "simulated history_entry failure");

    await expect(svc.grab({
      mediaType: "movie", mediaId: "m1", releaseId: "r1", indexerId: "idx1",
      release: release(),
    })).rejects.toThrow(/simulated history_entry failure/);

    const queueRows = db.select().from(schema.downloadQueueEntry).all();
    expect(queueRows).toHaveLength(0);
    const historyRows = db.select().from(schema.historyEntry).all();
    expect(historyRows).toHaveLength(0);
  });
});

describe("AcquisitionService import-apply is transactional", () => {
  async function seedMovie(db: Db, mediaRoot: string) {
    const now = new Date().toISOString();
    await db.insert(schema.movie).values({
      id: "m1", tmdbId: 1, title: "Txn Movie", overview: "", status: "released", releaseDate: "2021-01-01",
      monitored: true, qualityProfileId: null, rootFolderPath: mediaRoot, minimumAvailability: "announced",
      genres: [], images: [], tags: [], hasFile: false, addedAt: now, updatedAt: now,
    });
  }

  async function seedQueueEntry(db: Db) {
    const now = new Date().toISOString();
    const row = {
      id: "q1", mediaType: "movie", mediaId: "m1", downloadClientId: null, downloadId: "d1",
      title: "Txn.Movie.2021.1080p.WEB-DL", status: "downloading", progress: 50, size: 2048,
      remainingTime: null, errorMessage: null, data: {} as Record<string, unknown>, addedAt: now, updatedAt: now,
    };
    await db.insert(schema.downloadQueueEntry).values(row);
    return row;
  }

  it("rolls back the media_file insert and movie.hasFile flip when the history insert fails", async () => {
    const { db, sqlite } = openDb(join(dir, "import.db"));
    const downloadsRoot = join(dir, "import-downloads");
    const mediaRoot = join(dir, "import-media");
    mkdirSync(downloadsRoot, { recursive: true });
    mkdirSync(mediaRoot, { recursive: true });
    const folder = join(downloadsRoot, "Txn.Movie.2021.1080p.WEB-DL");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "movie.mkv"), Buffer.alloc(2048));

    const config = new ConfigService(db);
    await config.upsert({ "paths.downloads": downloadsRoot });
    await seedMovie(db, mediaRoot);
    const entry = await seedQueueEntry(db);

    const events = new EventsService(new EventBus());
    const providers = {} as unknown as ProvidersService;
    const blocklist = new BlocklistService(db);
    const service = new AcquisitionService(
      db, config, events, providers, new MediaRepository(db), blocklist,
      new RootFoldersService(db, new ConfigService(db)), new RemotePathMappingsService(db), new RecycleBinService(config),
      new ProviderStatusService(db, config),
    );

    const item: ClientQueueItem = { downloadId: "d1", title: entry.title, status: "completed", progress: 100, size: 2048, contentPath: folder };

    // importMovie()'s transaction writes media_file, then updates movie.hasFile, then
    // availability, then history, then marks the queue entry imported — fail the history
    // write (well after the media_file insert and movie update) and confirm none of the
    // earlier writes in the same transaction survive either.
    throwOnPrepare(sqlite, 'into "history_entry"', "simulated history_entry failure");

    const entryRow = db.select().from(schema.downloadQueueEntry).where(eq(schema.downloadQueueEntry.id, "q1")).get()!;
    await expect(service.importCompletedEntry(entryRow, item)).rejects.toThrow(/simulated history_entry failure/);

    expect(db.select().from(schema.mediaFile).all()).toHaveLength(0);
    const movie = db.select().from(schema.movie).where(eq(schema.movie.id, "m1")).get()!;
    expect(movie.hasFile).toBe(false);
    const queue = db.select().from(schema.downloadQueueEntry).where(eq(schema.downloadQueueEntry.id, "q1")).get()!;
    expect(queue.status).toBe("downloading"); // not flipped to "imported"
  });
});

describe("MoviesService.remove() / SeriesService.remove() cascade (roadmap P0.7, gap report J2)", () => {
  it("deleting a series removes its seasons, episodes, and every polymorphic row referencing it", async () => {
    const { db } = openDb(join(dir, "series-cascade.db"));
    const now = new Date().toISOString();
    await db.insert(schema.series).values({
      id: "s1", tvdbId: 1, tmdbId: null, imdbId: null, title: "Cascade Show", overview: "",
      status: "continuing", seriesType: "standard", network: null, firstAirYear: 2020,
      monitored: true, qualityProfileId: null, rootFolderPath: "", genres: [], images: [], tags: [], addedAt: now, updatedAt: now,
    });
    await db.insert(schema.season).values({ id: "sea1", seriesId: "s1", seasonNumber: 1, monitored: true });
    await db.insert(schema.episode).values({
      id: "ep1", seriesId: "s1", seasonId: "sea1", episodeNumber: 1, absoluteNumber: null, title: "", overview: "",
      airDateUtc: null, monitored: true, hasFile: false, sceneSeasonNumber: null, sceneEpisodeNumber: null,
    });
    // Every polymorphic table that points at a series via (mediaType, mediaId).
    await db.insert(schema.mediaFile).values({ id: "mf1", mediaType: "series", mediaId: "s1", episodeIds: ["ep1"], relativePath: "x.mkv", size: 1, quality: { source: "web", resolution: "1080p", edition: "" }, dateAdded: now });
    await db.insert(schema.downloadQueueEntry).values({ id: "q1", mediaType: "series", mediaId: "s1", downloadClientId: null, downloadId: "d1", title: "x", status: "downloading", progress: 0, size: 0, remainingTime: null, errorMessage: null, data: {}, addedAt: now, updatedAt: now });
    await db.insert(schema.historyEntry).values({ id: "h1", mediaType: "series", mediaId: "s1", action: "grabbed", data: {}, createdAt: now });
    await db.insert(schema.mediaAvailability).values({ id: "av1", mediaType: "series", mediaId: "s1", status: "unknown" });
    await db.insert(schema.blocklistEntry).values({ id: "bl1", mediaType: "series", mediaId: "s1", indexerId: null, title: "x", torrentInfohash: null, reason: "x", createdAt: now });

    const service = new SeriesService(db, new EventsService(new EventBus()), new AutoTagsService(db));
    await service.remove("s1");

    expect(db.select().from(schema.series).all()).toHaveLength(0);
    expect(db.select().from(schema.season).all()).toHaveLength(0); // DB-level FK cascade
    expect(db.select().from(schema.episode).all()).toHaveLength(0); // DB-level FK cascade
    expect(db.select().from(schema.mediaFile).all()).toHaveLength(0); // app-level polymorphic cascade
    expect(db.select().from(schema.downloadQueueEntry).all()).toHaveLength(0);
    expect(db.select().from(schema.historyEntry).all()).toHaveLength(0);
    expect(db.select().from(schema.mediaAvailability).all()).toHaveLength(0);
    expect(db.select().from(schema.blocklistEntry).all()).toHaveLength(0);
  });

  it("deleting a movie removes every polymorphic row referencing it", async () => {
    const { db } = openDb(join(dir, "movie-cascade.db"));
    const now = new Date().toISOString();
    await db.insert(schema.movie).values({
      id: "m1", tmdbId: 1, title: "Cascade Movie", overview: "", status: "released", releaseDate: "2021-01-01",
      monitored: true, qualityProfileId: null, rootFolderPath: "", minimumAvailability: "announced",
      genres: [], images: [], tags: [], hasFile: false, addedAt: now, updatedAt: now,
    });
    await db.insert(schema.mediaFile).values({ id: "mf1", mediaType: "movie", mediaId: "m1", episodeIds: [], relativePath: "x.mkv", size: 1, quality: { source: "web", resolution: "1080p", edition: "" }, dateAdded: now });
    await db.insert(schema.downloadQueueEntry).values({ id: "q1", mediaType: "movie", mediaId: "m1", downloadClientId: null, downloadId: "d1", title: "x", status: "downloading", progress: 0, size: 0, remainingTime: null, errorMessage: null, data: {}, addedAt: now, updatedAt: now });
    await db.insert(schema.historyEntry).values({ id: "h1", mediaType: "movie", mediaId: "m1", action: "grabbed", data: {}, createdAt: now });
    await db.insert(schema.mediaAvailability).values({ id: "av1", mediaType: "movie", mediaId: "m1", status: "unknown" });
    await db.insert(schema.blocklistEntry).values({ id: "bl1", mediaType: "movie", mediaId: "m1", indexerId: null, title: "x", torrentInfohash: null, reason: "x", createdAt: now });

    const service = new MoviesService(db, new EventsService(new EventBus()), new AutoTagsService(db));
    await service.remove("m1");

    expect(db.select().from(schema.movie).all()).toHaveLength(0);
    expect(db.select().from(schema.mediaFile).all()).toHaveLength(0);
    expect(db.select().from(schema.downloadQueueEntry).all()).toHaveLength(0);
    expect(db.select().from(schema.historyEntry).all()).toHaveLength(0);
    expect(db.select().from(schema.mediaAvailability).all()).toHaveLength(0);
    expect(db.select().from(schema.blocklistEntry).all()).toHaveLength(0);
  });
});
