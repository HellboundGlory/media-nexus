// SPDX-License-Identifier: MIT
/**
 * Roadmap D2 (real RSS sync): before this, `RssSyncService`'s only mechanism was a
 * per-title active search — "closer to Sonarr's MissingEpisodeSearchService than to
 * RssSyncService," per the gap report. This covers `runFeedPoll()`, the real passive
 * mechanism: one category-only pull, reverse-matched against the whole wanted/missing
 * list, deduped against the seen-release cache. Every test uses a real DB (not a stub) —
 * runFeedPoll() unconditionally reads/writes seen_release, so a stub would need to
 * reimplement that table's select/insert semantics anyway. Follows
 * `movie-automation.spec.ts`'s isolation convention for the piece that doesn't need a
 * real DB: decisions.evaluate() is stubbed with the pure domain evaluate(), keeping
 * DecisionService's own context assembly (covered separately in decision.spec.ts) out of
 * scope for these tests.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "@medianexus/events";
import { createDb, schema } from "@medianexus/database";
import { evaluate, type Release } from "@medianexus/domain";
import { RssSyncService } from "../src/acquisition/rss-sync.service";
import { EventsService } from "../src/events/events.service";
import type { IndexersService } from "../src/indexers/indexers.service";
import type { MoviesService, WantedMovie } from "../src/movies/movies.service";
import type { SeriesService } from "../src/series/series.service";
import type { DecisionService } from "../src/decision/decision.service";

const dir = mkdtempSync(join(tmpdir(), "mn-rss-poll-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });

let counter = 0;
async function freshDb() {
  const handle = createDb(join(dir, `rp-${counter++}.db`));
  handle.runMigrations();
  handles.push(handle);
  const db = handle.db;
  const now = new Date().toISOString();
  // seen_release.indexerId has a real FK to indexer.id — every release the poll marks
  // seen needs its indexer row to already exist.
  await db.insert(schema.indexer).values({
    id: "idx1", definitionKey: "newznab", name: "Demo", protocol: "usenet", enabled: true,
    implementation: "newznab", settings: {}, priority: 25, status: "ok", tags: [], createdAt: now, updatedAt: now,
  });
  return db;
}

function release(over: Partial<Release> = {}): Release {
  return {
    id: "r1", indexerId: "idx1", indexerName: "Demo", title: "Interstellar.2014.1080p.WEB-DL",
    protocol: "torrent", categories: [], size: 1000, ageHours: 1, seeders: 10, leechers: 1,
    quality: { source: "web", resolution: "1080p", edition: "" },
    isFreeleech: false, isProper: false, isRepack: false,
    ...over,
  };
}

const movieCtx = {
  target: { kind: "movie" as const, mediaType: "movie" as const, mediaId: "m1" },
  profile: null, existingFiles: [], hasActiveQueueConflict: false,
  preferredProtocol: "any" as const, isBlocklisted: false,
};
const episodeCtx = {
  target: { kind: "episode" as const, mediaType: "series" as const, mediaId: "s1", seasonNumber: 2, episodes: [], isSeasonPack: false },
  profile: null, existingFiles: [], hasActiveQueueConflict: false,
  preferredProtocol: "any" as const, isBlocklisted: false,
};

// runFeedPoll() calls decisions.evaluate() per matched release — stub it with the pure
// domain evaluate(), same isolation principle movie-automation.spec.ts already uses for
// runMissingSearch(): RssSyncService's own matching/grouping/dedupe logic is under test,
// not DecisionService's context assembly (covered separately in decision.spec.ts).
function decisionsStub(ctxFor: (mediaType: string, mediaId: string) => typeof movieCtx | typeof episodeCtx): DecisionService {
  return {
    evaluate: async (mediaType: string, mediaId: string, r: Release) => evaluate(r, ctxFor(mediaType, mediaId)),
  } as unknown as DecisionService;
}

const wantedMovie: WantedMovie = {
  id: "m1", mediaType: "movie", title: "Interstellar", releaseDate: "2014-11-05",
  minimumAvailability: "announced", monitored: true, hasFile: false,
};

function wantedEpisode(over: Partial<{ id: string; episodeNumber: number; seasonNumber: number }> = {}) {
  return {
    id: "ep1", seriesId: "s1", seasonId: "sea2", episodeNumber: 1, absoluteNumber: null,
    title: "", overview: "", airDateUtc: null, monitored: true, hasFile: false,
    sceneSeasonNumber: null, sceneEpisodeNumber: null, seasonNumber: 2, seriesTitle: "Show",
    ...over,
  };
}

describe("RssSyncService.runFeedPoll() — matching", () => {
  it("grabs a movie release matched by title+year alone (no targeted query)", async () => {
    const db = await freshDb();
    const grabbed: string[] = [];
    const indexers = {
      pollRecent: async () => [release()],
      grab: async (input: { releaseId: string }) => { grabbed.push(input.releaseId); return {}; },
    } as unknown as IndexersService;
    const movies = { wantedMissing: async () => [wantedMovie] } as unknown as MoviesService;
    const series = { wantedMissing: async () => [] } as unknown as SeriesService;
    const rss = new RssSyncService(db, indexers, series, movies, new EventsService(new EventBus()), decisionsStub(() => movieCtx));

    const result = await rss.runFeedPoll();
    expect(result.matched).toBe(1);
    expect(result.grabbed).toBe(1);
    expect(grabbed).toEqual(["r1"]);
  });

  it("does not match when two wanted movies share a title (ambiguous)", async () => {
    const db = await freshDb();
    const grabbed: string[] = [];
    const indexers = {
      pollRecent: async () => [release()],
      grab: async (input: { releaseId: string }) => { grabbed.push(input.releaseId); return {}; },
    } as unknown as IndexersService;
    const dup: WantedMovie = { ...wantedMovie, id: "m2" };
    const movies = { wantedMissing: async () => [wantedMovie, dup] } as unknown as MoviesService;
    const series = { wantedMissing: async () => [] } as unknown as SeriesService;
    const rss = new RssSyncService(db, indexers, series, movies, new EventsService(new EventBus()), decisionsStub(() => movieCtx));

    const result = await rss.runFeedPoll();
    expect(result.matched).toBe(0);
    expect(grabbed).toEqual([]);
  });

  it("does not match a release for a title with no wanted candidate at all", async () => {
    const db = await freshDb();
    const indexers = {
      pollRecent: async () => [release({ title: "Some.Unrelated.Film.2014.1080p.WEB-DL" })],
      grab: async () => ({}),
    } as unknown as IndexersService;
    const movies = { wantedMissing: async () => [wantedMovie] } as unknown as MoviesService;
    const series = { wantedMissing: async () => [] } as unknown as SeriesService;
    const rss = new RssSyncService(db, indexers, series, movies, new EventsService(new EventBus()), decisionsStub(() => movieCtx));

    const result = await rss.runFeedPoll();
    expect(result.matched).toBe(0);
  });

  it("matches a season-pack release to a wanted episode in that season", async () => {
    const db = await freshDb();
    const grabbed: string[] = [];
    const indexers = {
      pollRecent: async () => [release({ id: "r-pack", title: "Show.S02.1080p.WEB-DL" })],
      grab: async (input: { releaseId: string }) => { grabbed.push(input.releaseId); return {}; },
    } as unknown as IndexersService;
    const movies = { wantedMissing: async () => [] } as unknown as MoviesService;
    const series = { wantedMissing: async () => [wantedEpisode()] } as unknown as SeriesService;
    const rss = new RssSyncService(db, indexers, series, movies, new EventsService(new EventBus()), decisionsStub(() => episodeCtx));

    const result = await rss.runFeedPoll();
    expect(result.matched).toBe(1);
    expect(grabbed).toEqual(["r-pack"]);
  });

  it("does not match a single-episode release naming an episode nobody wants in that season", async () => {
    const db = await freshDb();
    const indexers = {
      pollRecent: async () => [release({ title: "Show.S02E09.1080p.WEB-DL" })], // only E01 is wanted below
      grab: async () => ({}),
    } as unknown as IndexersService;
    const movies = { wantedMissing: async () => [] } as unknown as MoviesService;
    const series = { wantedMissing: async () => [wantedEpisode({ episodeNumber: 1 })] } as unknown as SeriesService;
    const rss = new RssSyncService(db, indexers, series, movies, new EventsService(new EventBus()), decisionsStub(() => episodeCtx));

    const result = await rss.runFeedPoll();
    expect(result.matched).toBe(0);
  });

  it("matches a release title whose embedded year is off by one, rejects off by two", async () => {
    const db1 = await freshDb();
    const grabbedOffByOne: string[] = [];
    const indexersOk = {
      pollRecent: async () => [release({ title: "Interstellar.2015.720p.WEB-DL" })],
      grab: async (input: { releaseId: string }) => { grabbedOffByOne.push(input.releaseId); return {}; },
    } as unknown as IndexersService;
    const movies = { wantedMissing: async () => [wantedMovie] } as unknown as MoviesService;
    const series = { wantedMissing: async () => [] } as unknown as SeriesService;
    const rssOk = new RssSyncService(db1, indexersOk, series, movies, new EventsService(new EventBus()), decisionsStub(() => movieCtx));
    expect((await rssOk.runFeedPoll()).matched).toBe(1);
    expect(grabbedOffByOne).toEqual(["r1"]);

    const db2 = await freshDb();
    const indexersRejected = {
      pollRecent: async () => [release({ title: "Interstellar.2020.720p.WEB-DL" })],
      grab: async () => ({}),
    } as unknown as IndexersService;
    const rssRejected = new RssSyncService(db2, indexersRejected, series, movies, new EventsService(new EventBus()), decisionsStub(() => movieCtx));
    expect((await rssRejected.runFeedPoll()).matched).toBe(0);
  });
});

describe("RssSyncService.runFeedPoll() — grouping picks the best of several matches for one target", () => {
  it("grabs only the better-quality release when two match the same wanted episode in one tick", async () => {
    const db = await freshDb();
    const grabbed: string[] = [];
    const worse = release({ id: "r-worse", title: "Show.S02E01.720p.WEB-DL", quality: { source: "web", resolution: "720p", edition: "" } });
    const better = release({ id: "r-better", title: "Show.S02E01.1080p.BluRay", quality: { source: "bluray", resolution: "1080p", edition: "" } });
    const indexers = {
      pollRecent: async () => [worse, better],
      grab: async (input: { releaseId: string }) => { grabbed.push(input.releaseId); return {}; },
    } as unknown as IndexersService;
    const movies = { wantedMissing: async () => [] } as unknown as MoviesService;
    const series = { wantedMissing: async () => [wantedEpisode()] } as unknown as SeriesService;
    const rss = new RssSyncService(db, indexers, series, movies, new EventsService(new EventBus()), decisionsStub(() => episodeCtx));

    const result = await rss.runFeedPoll();
    expect(result.matched).toBe(1); // one target, even though two releases matched it
    expect(result.grabbed).toBe(1);
    expect(grabbed).toEqual(["r-better"]);
  });
});

describe("RssSyncService.runFeedPoll() — seen-release cache", () => {
  it("only processes a given (indexer, guid) once across repeated polls", async () => {
    const db = await freshDb();
    let calls = 0;
    const grabbed: string[] = [];
    const indexers = {
      pollRecent: async () => { calls++; return [release()]; },
      grab: async (input: { releaseId: string }) => { grabbed.push(input.releaseId); return {}; },
    } as unknown as IndexersService;
    const movies = { wantedMissing: async () => [wantedMovie] } as unknown as MoviesService;
    const series = { wantedMissing: async () => [] } as unknown as SeriesService;
    const rss = new RssSyncService(db, indexers, series, movies, new EventsService(new EventBus()), decisionsStub(() => movieCtx));

    const first = await rss.runFeedPoll();
    expect(first.unseen).toBe(1);
    expect(first.grabbed).toBe(1);

    const second = await rss.runFeedPoll();
    expect(calls).toBe(2); // the indexer is still polled every tick...
    expect(second.unseen).toBe(0); // ...but the same guid is no longer "unseen"
    expect(second.matched).toBe(0);
    expect(grabbed).toEqual(["r1"]); // not regrabbed
  });

  it("still processes a different guid from the same indexer", async () => {
    const db = await freshDb();
    let call = 0;
    const indexers = {
      pollRecent: async () => { call++; return [release({ id: call === 1 ? "r1" : "r2" })]; },
      grab: async () => ({}),
    } as unknown as IndexersService;
    const movies = { wantedMissing: async () => [] } as unknown as MoviesService; // nothing wanted -> nothing matched, only testing "unseen" here
    const series = { wantedMissing: async () => [] } as unknown as SeriesService;
    const rss = new RssSyncService(db, indexers, series, movies, new EventsService(new EventBus()), decisionsStub(() => movieCtx));

    expect((await rss.runFeedPoll()).unseen).toBe(1); // r1
    expect((await rss.runFeedPoll()).unseen).toBe(1); // r2, a different guid
  });

  it("prunes seen_release rows older than the retention window", async () => {
    const db = await freshDb();
    const old = new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString(); // 20 days ago
    const recent = new Date().toISOString();
    await db.insert(schema.seenRelease).values([
      { id: "sr-old", indexerId: "idx1", guid: "old-guid", firstSeenAt: old },
      { id: "sr-recent", indexerId: "idx1", guid: "recent-guid", firstSeenAt: recent },
    ]);

    const indexers = { pollRecent: async () => [], grab: async () => ({}) } as unknown as IndexersService;
    const movies = { wantedMissing: async () => [] } as unknown as MoviesService;
    const series = { wantedMissing: async () => [] } as unknown as SeriesService;
    const rss = new RssSyncService(db, indexers, series, movies, new EventsService(new EventBus()), decisionsStub(() => movieCtx));
    await rss.runFeedPoll();

    const remaining = (await db.select().from(schema.seenRelease)).map((r) => r.guid);
    expect(remaining).toEqual(["recent-guid"]);
  });
});

describe("RssSyncService.runFeedPoll() — active-queue / recently-grabbed dedupe", () => {
  it("skips a matched movie with an active queue entry", async () => {
    const db = await freshDb();
    const now = new Date().toISOString();
    await db.insert(schema.downloadQueueEntry).values({
      id: "q1", mediaType: "movie", mediaId: "m1", downloadClientId: null, downloadId: "d1",
      title: "x", status: "downloading", progress: 10, size: 0, remainingTime: null, errorMessage: null,
      data: {}, addedAt: now, updatedAt: now,
    });
    const grabbed: string[] = [];
    const indexers = {
      pollRecent: async () => [release()],
      grab: async (input: { releaseId: string }) => { grabbed.push(input.releaseId); return {}; },
    } as unknown as IndexersService;
    const movies = { wantedMissing: async () => [wantedMovie] } as unknown as MoviesService;
    const series = { wantedMissing: async () => [] } as unknown as SeriesService;
    const rss = new RssSyncService(db, indexers, series, movies, new EventsService(new EventBus()), decisionsStub(() => movieCtx));

    const result = await rss.runFeedPoll();
    expect(result.matched).toBe(1); // still matched...
    expect(result.grabbed).toBe(0); // ...just not grabbed
    expect(grabbed).toEqual([]);
  });

  it("skips a matched movie grabbed within the last 6 hours", async () => {
    const db = await freshDb();
    const now = new Date().toISOString();
    await db.insert(schema.historyEntry).values({
      id: "h1", mediaType: "movie", mediaId: "m1", action: "grabbed",
      data: { releaseTitle: "Interstellar.2014.1080p.WEB-DL" }, createdAt: now,
    });
    const grabbed: string[] = [];
    const indexers = {
      pollRecent: async () => [release()],
      grab: async (input: { releaseId: string }) => { grabbed.push(input.releaseId); return {}; },
    } as unknown as IndexersService;
    const movies = { wantedMissing: async () => [wantedMovie] } as unknown as MoviesService;
    const series = { wantedMissing: async () => [] } as unknown as SeriesService;
    const rss = new RssSyncService(db, indexers, series, movies, new EventsService(new EventBus()), decisionsStub(() => movieCtx));

    const result = await rss.runFeedPoll();
    expect(result.grabbed).toBe(0);
    expect(grabbed).toEqual([]);
  });
});
