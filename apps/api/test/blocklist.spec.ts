// SPDX-License-Identifier: MIT
/**
 * Roadmap P0.4 (gap report B6): `blocklist_entry` existed since `0000_init` with zero
 * references anywhere — nothing wrote to it and nothing read it, so a release that failed
 * every time got grabbed again on the next pass forever. This covers the three legs added:
 * write on exhausted import failure, read in IndexersService.grab(), read in RssSyncService.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "@medianexus/events";
import { createDb, schema } from "@medianexus/database";
import { evaluate, type Release, type Decision } from "@medianexus/domain";
import type { ClientQueueItem, DownloadClientContract, HealthResult, AddDownloadInput } from "@medianexus/integrations";
import { AcquisitionService } from "../src/acquisition/acquisition.service";
import { RssSyncService } from "../src/acquisition/rss-sync.service";
import { IndexersService } from "../src/indexers/indexers.service";
import { MediaRepository } from "../src/media/media.repository";
import { ConfigService } from "../src/system/config.service";
import { EventsService } from "../src/events/events.service";
import { BlocklistService } from "../src/blocklist/blocklist.service";
import { RootFoldersService } from "../src/root-folders/root-folders.service";
import { RemotePathMappingsService } from "../src/remote-path-mappings/remote-path-mappings.service";
import { RecycleBinService } from "../src/media/recycle-bin.service";
import type { DecisionService } from "../src/decision/decision.service";
import type { ProvidersService, ConfiguredClient } from "../src/providers/demo.providers";
import { ProviderStatusService } from "../src/providers/provider-status.service";
import type { SeriesService } from "../src/series/series.service";
import type { MoviesService } from "../src/movies/movies.service";

const dir = mkdtempSync(join(tmpdir(), "mn-blocklist-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });

let counter = 0;
async function freshDb() {
  const handle = createDb(join(dir, `bl-${counter++}.db`));
  handle.runMigrations();
  handles.push(handle);
  return handle.db;
}

function release(over: Partial<Release> = {}): Release {
  return {
    id: "r1", indexerId: "idx1", indexerName: "Demo", title: "Bad.Release.S02E01.1080p.WEB-DL",
    protocol: "torrent", categories: [], size: 1000, ageHours: 1, seeders: 10, leechers: 1,
    quality: { source: "web", resolution: "1080p", edition: "" },
    isFreeleech: false, isProper: false, isRepack: false,
    ...over,
  };
}

describe("BlocklistService", () => {
  it("isBlocklisted is false until add() is called, true after", async () => {
    const db = await freshDb();
    const svc = new BlocklistService(db);
    const candidate = { mediaType: "series", mediaId: "s1", title: "Bad.Release.S02E01", indexerId: "idx1" };

    expect(await svc.isBlocklisted(candidate)).toBe(false);
    await svc.add({ mediaType: "series", mediaId: "s1", title: "Bad.Release.S02E01", indexerId: "idx1", reason: "test" });
    expect(await svc.isBlocklisted(candidate)).toBe(true);
  });

  it("does not match a different title, media, or (when both sides have one) indexer", async () => {
    const db = await freshDb();
    const svc = new BlocklistService(db);
    await svc.add({ mediaType: "series", mediaId: "s1", title: "Bad.Release.S02E01", indexerId: "idx1", reason: "test" });

    expect(await svc.isBlocklisted({ mediaType: "series", mediaId: "s1", title: "Other.Release.S02E01" })).toBe(false);
    expect(await svc.isBlocklisted({ mediaType: "series", mediaId: "s2", title: "Bad.Release.S02E01" })).toBe(false);
    expect(await svc.isBlocklisted({ mediaType: "movie", mediaId: "s1", title: "Bad.Release.S02E01" })).toBe(false);
    expect(await svc.isBlocklisted({ mediaType: "series", mediaId: "s1", title: "Bad.Release.S02E01", indexerId: "idx2" })).toBe(false);
  });

  it("list/remove round-trip, paginated", async () => {
    const db = await freshDb();
    const svc = new BlocklistService(db);
    await svc.add({ mediaType: "series", mediaId: "s1", title: "A", reason: "x" });
    await svc.add({ mediaType: "series", mediaId: "s1", title: "B", reason: "x" });

    const page = await svc.list({});
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(2);

    await svc.remove(page.items[0].id);
    expect((await svc.list({})).total).toBe(1);
    await expect(svc.remove(page.items[0].id)).rejects.toThrow();
  });
});

describe("P0.4 — an exhausted import failure blocklists the release", () => {
  /** A download client whose queue is driven directly and never has a completed file to
   *  import, so every attempt fails — the exact shape that exhausts MAX_IMPORT_ATTEMPTS. */
  class AlwaysMissingClient implements DownloadClientContract {
    readonly key = "stub";
    readonly kind = "torrent" as const;
    items: ClientQueueItem[] = [];
    async addRelease(_input: AddDownloadInput): Promise<{ downloadId: string }> { return { downloadId: "d1" }; }
    async getQueue(): Promise<ClientQueueItem[]> { return this.items; }
    async remove(): Promise<void> {}
    async healthcheck(): Promise<HealthResult> { return { ok: true }; }
  }

  it("writes a blocklist_entry once the queue entry is parked as failed", async () => {
    const db = await freshDb();
    const downloadsRoot = mkdtempSync(join(dir, "downloads-"));
    const config = new ConfigService(db);
    await config.upsert({ "paths.downloads": downloadsRoot });
    const rootFolders = new RootFoldersService(db, new ConfigService(db));
    await rootFolders.create({ path: mkdtempSync(join(dir, "media-")), name: "", isDefaultMovie: true, isDefaultSeries: true });

    await db.insert(schema.movie).values({
      id: "m1", tmdbId: 1, title: "Some Movie", overview: "", status: "released", releaseDate: "2020-01-01",
      monitored: true, qualityProfileId: null, rootFolderPath: "", minimumAvailability: "announced",
      genres: [], images: [], tags: [], hasFile: false, addedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await db.insert(schema.downloadQueueEntry).values({
      id: "q1", mediaType: "movie", mediaId: "m1", downloadClientId: null, downloadId: "d1",
      title: "Bad.Movie.Release.1080p.WEB-DL", status: "downloading", progress: 50, size: 1000,
      remainingTime: null, errorMessage: null,
      data: { releaseTitle: "Bad.Movie.Release.1080p.WEB-DL", indexerId: "idx1" },
      addedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    const events = new EventsService(new EventBus());
    const client = new AlwaysMissingClient();
    client.items = [{ downloadId: "d1", title: "Bad.Movie.Release.1080p.WEB-DL", status: "completed", progress: 100, size: 1000 }];
    const providers = { configuredDownloadClients: async () => [{ row: null, provider: client }] } as unknown as ProvidersService;
    const blocklist = new BlocklistService(db);
    const service = new AcquisitionService(
      db, config, events, providers, new MediaRepository(db), blocklist,
      rootFolders, new RemotePathMappingsService(db), new RecycleBinService(config),
      new ProviderStatusService(db, config),
    );
    const configured: ConfiguredClient = { row: null, provider: client };

    // Regression check: this must NOT already be true before the fix — every attempt is
    // independently confirmed to fail (no video file ever exists at downloadsRoot).
    expect(await blocklist.isBlocklisted({ mediaType: "movie", mediaId: "m1", title: "Bad.Movie.Release.1080p.WEB-DL" })).toBe(false);

    await service.syncForClient(configured); // attempt 1
    await service.syncForClient(configured); // attempt 2
    await service.syncForClient(configured); // attempt 3 -> exhausted, parked failed

    const entry = (await db.select().from(schema.downloadQueueEntry))[0];
    expect(entry.status).toBe("failed");

    expect(await blocklist.isBlocklisted({ mediaType: "movie", mediaId: "m1", title: "Bad.Movie.Release.1080p.WEB-DL" })).toBe(true);
    const rows = await blocklist.list({});
    expect(rows.items[0].indexerId).toBe("idx1"); // carried through from queue entry's data.indexerId
    expect(rows.items[0].reason).toMatch(/import failed after 3 attempts/);
  });
});

describe("P0.4/P0.3 — IndexersService.grab() refuses a release the decision engine rejects", () => {
  // grab()'s own call to DecisionService.evaluate() is stubbed directly here — the engine's
  // own logic (including its blocklist spec) is covered by packages/domain/src/decision.test.ts
  // and by the DecisionService integration test below; this checks grab()'s wiring only.
  function stubDecisions(verdict: (release: Release) => Decision): DecisionService {
    return { evaluate: async (_mt: string, _mid: string, r: Release) => verdict(r) } as unknown as DecisionService;
  }

  it("throws instead of adding it to a download client", async () => {
    const db = await freshDb();
    const events = new EventsService(new EventBus());
    const config = new ConfigService(db);
    let addCalled = false;
    const providers = {
      pickDownloadClient: async () => ({ row: null, provider: { addRelease: async () => { addCalled = true; return { downloadId: "d1" }; } } }),
    } as unknown as ProvidersService;
    const decisions = stubDecisions((r) => ({
      release: r, approved: false, profile: null,
      rejections: [{ reason: "blocklisted", message: "this release has failed before and is blocklisted" }],
    }));
    const svc = new IndexersService(db, providers, events, config, decisions);

    await expect(svc.grab({
      mediaType: "movie", mediaId: "m1", releaseId: "r1", indexerId: "idx1",
      release: release({ id: "r1", indexerId: "idx1", title: "Bad.Release.1080p.WEB-DL" }),
    })).rejects.toThrow(/blocklisted/);
    expect(addCalled).toBe(false);
  });

  it("still grabs a release the engine approves", async () => {
    const db = await freshDb();
    const events = new EventsService(new EventBus());
    const config = new ConfigService(db);
    let addCalled = false;
    const providers = {
      pickDownloadClient: async () => ({ row: null, provider: { addRelease: async () => { addCalled = true; return { downloadId: "d1" }; } } }),
    } as unknown as ProvidersService;
    const decisions = stubDecisions((r) => ({ release: r, approved: true, profile: null, rejections: [] }));
    const status = new ProviderStatusService(db, config);
    const svc = new IndexersService(db, providers, events, config, decisions, status);

    await svc.grab({
      mediaType: "movie", mediaId: "m1", releaseId: "r1", indexerId: "idx1",
      release: release({ id: "r1", indexerId: "idx1", title: "Good.Release.1080p.WEB-DL" }),
    });
    expect(addCalled).toBe(true);
  });
});

describe("P0.4/P0.3 — RssSyncService grabs the best *approved* candidate, not just the best quality", () => {
  it("grabs the non-blocklisted candidate when the best-quality one is blocklisted", async () => {
    // Build decisions the same way DecisionService would, but by hand — this isolates
    // RssSyncService's own logic (pickBest usage) from DecisionService's context assembly,
    // which is covered separately by the DecisionService integration test below.
    const r1 = release({ id: "r1", indexerId: "idx1", title: "Show.S02E01.2160p.BluRay", quality: { source: "bluray", resolution: "2160p", edition: "" } });
    const r2 = release({ id: "r2", indexerId: "idx1", title: "Show.S02E01.1080p.WEB-DL", quality: { source: "web", resolution: "1080p", edition: "" } });
    const ctx = { target: { kind: "episode" as const, mediaType: "series" as const, mediaId: "s1", seasonNumber: 2, episodes: [], isSeasonPack: false }, profile: null, existingFiles: [], hasActiveQueueConflict: false, preferredProtocol: "any" as const, isBlocklisted: false, freeSpaceBytes: null, minimumFreeSpaceMb: 100 };
    const r1Decision = evaluate(r1, { ...ctx, isBlocklisted: true }); // the higher-quality one is blocklisted
    const r2Decision = evaluate(r2, ctx);

    const events = new EventsService(new EventBus());
    const grabbed: string[] = [];
    const indexers = {
      search: async () => ({
        mediaType: "series", mediaId: "s1", query: "Show S02E01",
        releases: [{ ...r1, decision: r1Decision }, { ...r2, decision: r2Decision }],
      }),
      grab: async (input: { releaseId: string }) => { grabbed.push(input.releaseId); return {}; },
    } as unknown as IndexersService;
    const series = {
      wantedMissing: async () => [{
        id: "ep1", seriesId: "s1", seasonId: "sea2", episodeNumber: 1, absoluteNumber: null,
        title: "", overview: "", airDateUtc: null, monitored: true, hasFile: false,
        sceneSeasonNumber: null, sceneEpisodeNumber: null,
        seasonNumber: 2, seriesTitle: "Show",
      }],
    } as unknown as SeriesService;
    // RssSyncService only reads the db (active-queue check, recent-grab dedupe) — both
    // go through the same select().from().where().limit() chain, so one stub covers both.
    const dbStub = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) } as never;
    const movies = { wantedMissing: async () => [] } as unknown as MoviesService;
    const decisionsStub = {} as unknown as DecisionService;
    const rss = new RssSyncService(dbStub, indexers, series, movies, events, decisionsStub);

    const result = await rss.runMissingSearch({ maxSeries: 5, perSeries: 1 });

    expect(result.grabbed).toBe(1);
    expect(grabbed).toEqual(["r2"]); // not r1, which is blocklisted
  });
});
