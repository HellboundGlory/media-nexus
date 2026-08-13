// SPDX-License-Identifier: MIT
/**
 * Roadmap P1 (gap report C1): before this, RssSyncService only ever searched for and
 * grabbed missing monitored EPISODES — no job, no service touched a `movie` row. This
 * covers the pieces that make movie automation real: MoviesService.wantedMissing()'s
 * minimum-availability gate, RssSyncService's movie pass (query construction, year/title
 * matching, the generalized active-queue/recently-grabbed dedupe shared with series), and
 * MetadataService.addFromDiscover()'s smart minimumAvailability default from TMDB's real
 * release date — the specific fix the gap report says must land before automation ships,
 * not after.
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { EventBus } from "@medianexus/events";
import { createDb, schema } from "@medianexus/database";
import { evaluate, type Release } from "@medianexus/domain";
import { MoviesService } from "../src/movies/movies.service";
import { RssSyncService } from "../src/acquisition/rss-sync.service";
import { MetadataService } from "../src/metadata/metadata.service";
import { SeriesService } from "../src/series/series.service";
import { ConfigService } from "../src/system/config.service";
import { EventsService } from "../src/events/events.service";
import type { IndexersService } from "../src/indexers/indexers.service";
import type { DecisionService } from "../src/decision/decision.service";
import type { TmdbProvider } from "@medianexus/integrations";

// runMissingSearch() (unlike runFeedPoll()) never calls DecisionService itself — it reuses
// decisions IndexersService.search() already attached, exactly like the stubbed indexers
// below already do — so an empty stub satisfies the constructor without needing real logic.
const decisionsStub = {} as unknown as DecisionService;

const dir = mkdtempSync(join(tmpdir(), "mn-movie-auto-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });

let counter = 0;
async function freshDb() {
  const handle = createDb(join(dir, `ma-${counter++}.db`));
  handle.runMigrations();
  handles.push(handle);
  return handle.db;
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

const approvedCtx = {
  target: { kind: "movie" as const, mediaType: "movie" as const, mediaId: "m1" },
  profile: null, existingFiles: [], hasActiveQueueConflict: false,
  preferredProtocol: "any" as const, isBlocklisted: false,
  freeSpaceBytes: null, minimumFreeSpaceMb: 100,
};

describe("MoviesService.wantedMissing()", () => {
  async function seedMovie(db: Awaited<ReturnType<typeof freshDb>>, over: Partial<typeof schema.movie.$inferInsert> = {}) {
    const now = new Date().toISOString();
    await db.insert(schema.movie).values({
      id: "m1", tmdbId: 1, title: "Wanted Movie", overview: "", status: "released", releaseDate: "2020-01-01",
      monitored: true, qualityProfileId: null, rootFolderPath: "", minimumAvailability: "announced",
      genres: [], images: [], tags: [], hasFile: false, addedAt: now, updatedAt: now,
      ...over,
    });
  }

  it("includes a monitored, missing, announced movie", async () => {
    const db = await freshDb();
    await seedMovie(db);
    const svc = new MoviesService(db, new EventsService(new EventBus()));
    const wanted = await svc.wantedMissing();
    expect(wanted.map((w) => w.id)).toEqual(["m1"]);
  });

  it("excludes a 'released'-gated movie whose release date is in the future", async () => {
    const db = await freshDb();
    await seedMovie(db, { minimumAvailability: "released", releaseDate: "2099-01-01" });
    const svc = new MoviesService(db, new EventsService(new EventBus()));
    expect(await svc.wantedMissing()).toEqual([]);
  });

  it("includes a 'released'-gated movie whose release date has passed", async () => {
    const db = await freshDb();
    await seedMovie(db, { minimumAvailability: "released", releaseDate: "2020-01-01" });
    const svc = new MoviesService(db, new EventsService(new EventBus()));
    const wanted = await svc.wantedMissing();
    expect(wanted.map((w) => w.id)).toEqual(["m1"]);
  });

  it("excludes an unmonitored movie", async () => {
    const db = await freshDb();
    await seedMovie(db, { monitored: false });
    const svc = new MoviesService(db, new EventsService(new EventBus()));
    expect(await svc.wantedMissing()).toEqual([]);
  });

  it("excludes a movie that already has a file", async () => {
    const db = await freshDb();
    await seedMovie(db, { hasFile: true });
    const svc = new MoviesService(db, new EventsService(new EventBus()));
    expect(await svc.wantedMissing()).toEqual([]);
  });
});

describe("RssSyncService — movie pass", () => {
  function stubIndexers(releases: Release[], grabbed: string[]): IndexersService {
    return {
      search: async () => {
        const decisions = releases.map((r) => evaluate(r, approvedCtx));
        return { mediaType: "movie", mediaId: "m1", query: "x", releases: releases.map((r, i) => ({ ...r, decision: decisions[i] })) };
      },
      grab: async (input: { releaseId: string }) => { grabbed.push(input.releaseId); return {}; },
    } as unknown as IndexersService;
  }

  const wantedMovie = {
    id: "m1", mediaType: "movie" as const, title: "Interstellar", releaseDate: "2014-11-05",
    minimumAvailability: "announced" as const, monitored: true, hasFile: false,
  };
  const dbStub = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) } as never;
  const seriesStub = { wantedMissing: async () => [] } as unknown as SeriesService;

  it("grabs the best approved candidate for a movie", async () => {
    const grabbed: string[] = [];
    const indexers = stubIndexers([release()], grabbed);
    const movies = { wantedMissing: async () => [wantedMovie] } as unknown as MoviesService;
    const rss = new RssSyncService(dbStub, indexers, seriesStub, movies, new EventsService(new EventBus()), decisionsStub);

    const result = await rss.runMissingSearch({ maxMovies: 5 });
    expect(result.grabbedMovies).toBe(1);
    expect(grabbed).toEqual(["r1"]);
  });

  it("matches a release title whose embedded year is off by one", async () => {
    const grabbed: string[] = [];
    const indexers = stubIndexers([release({ title: "Interstellar.2015.720p.WEB-DL" })], grabbed);
    const movies = { wantedMissing: async () => [wantedMovie] } as unknown as MoviesService;
    const rss = new RssSyncService(dbStub, indexers, seriesStub, movies, new EventsService(new EventBus()), decisionsStub);

    const result = await rss.runMissingSearch({ maxMovies: 5 });
    expect(result.grabbedMovies).toBe(1);
  });

  it("rejects a release title whose embedded year is off by two or more", async () => {
    const grabbed: string[] = [];
    const indexers = stubIndexers([release({ title: "Interstellar.2020.720p.WEB-DL" })], grabbed);
    const movies = { wantedMissing: async () => [wantedMovie] } as unknown as MoviesService;
    const rss = new RssSyncService(dbStub, indexers, seriesStub, movies, new EventsService(new EventBus()), decisionsStub);

    const result = await rss.runMissingSearch({ maxMovies: 5 });
    expect(result.grabbedMovies).toBe(0);
    expect(grabbed).toEqual([]);
  });

  it("rejects a release with an unrelated title regardless of a matching year", async () => {
    const grabbed: string[] = [];
    const indexers = stubIndexers([release({ title: "Some.Other.Movie.2014.1080p.WEB-DL" })], grabbed);
    const movies = { wantedMissing: async () => [wantedMovie] } as unknown as MoviesService;
    const rss = new RssSyncService(dbStub, indexers, seriesStub, movies, new EventsService(new EventBus()), decisionsStub);

    const result = await rss.runMissingSearch({ maxMovies: 5 });
    expect(result.grabbedMovies).toBe(0);
    expect(grabbed).toEqual([]);
  });
});

describe("RssSyncService — generalized active-queue / recently-grabbed dedupe (real DB)", () => {
  const wantedMovie = {
    id: "m1", mediaType: "movie" as const, title: "Interstellar", releaseDate: "2014-11-05",
    minimumAvailability: "announced" as const, monitored: true, hasFile: false,
  };
  function stubIndexers(grabbed: string[]): IndexersService {
    return {
      search: async () => {
        const r = release();
        return { mediaType: "movie", mediaId: "m1", query: "x", releases: [{ ...r, decision: evaluate(r, approvedCtx) }] };
      },
      grab: async (input: { releaseId: string }) => { grabbed.push(input.releaseId); return {}; },
    } as unknown as IndexersService;
  }

  it("skips a movie with an active queue entry", async () => {
    const db = await freshDb();
    const now = new Date().toISOString();
    await db.insert(schema.downloadQueueEntry).values({
      id: "q1", mediaType: "movie", mediaId: "m1", downloadClientId: null, downloadId: "d1",
      title: "x", status: "downloading", progress: 10, size: 0, remainingTime: null, errorMessage: null,
      data: {}, addedAt: now, updatedAt: now,
    });
    const grabbed: string[] = [];
    const movies = { wantedMissing: async () => [wantedMovie] } as unknown as MoviesService;
    const seriesStub = { wantedMissing: async () => [] } as unknown as SeriesService;
    const rss = new RssSyncService(db, stubIndexers(grabbed), seriesStub, movies, new EventsService(new EventBus()), decisionsStub);

    const result = await rss.runMissingSearch({ maxMovies: 5 });
    expect(result.grabbedMovies).toBe(0);
    expect(grabbed).toEqual([]);
  });

  it("skips a movie grabbed within the last 6 hours", async () => {
    const db = await freshDb();
    const now = new Date().toISOString();
    await db.insert(schema.historyEntry).values({
      id: "h1", mediaType: "movie", mediaId: "m1", action: "grabbed",
      data: { releaseTitle: "Interstellar.2014.1080p.WEB-DL" }, createdAt: now,
    });
    const grabbed: string[] = [];
    const movies = { wantedMissing: async () => [wantedMovie] } as unknown as MoviesService;
    const seriesStub = { wantedMissing: async () => [] } as unknown as SeriesService;
    const rss = new RssSyncService(db, stubIndexers(grabbed), seriesStub, movies, new EventsService(new EventBus()), decisionsStub);

    const result = await rss.runMissingSearch({ maxMovies: 5 });
    expect(result.grabbedMovies).toBe(0);
    expect(grabbed).toEqual([]);
  });
});

describe("MetadataService.addFromDiscover() — smart minimumAvailability default", () => {
  function stubProvider(releaseDate: string | undefined): TmdbProvider {
    return {
      getDetails: async () => ({ externalId: "1", title: "Discover Movie", releaseDate, overview: "", genres: [], images: [] }),
    } as unknown as TmdbProvider;
  }

  it("defaults to 'released' when TMDB's release date is in the future", async () => {
    const db = await freshDb();
    const config = new ConfigService(db);
    await config.upsert({ "metadata.tmdbApiKey": "test-key" });
    const movies = new MoviesService(db, new EventsService(new EventBus()));
    const series = new SeriesService(db, new EventsService(new EventBus()));
    const svc = new MetadataService(db, config, movies, series);
    vi.spyOn(svc, "provider").mockResolvedValue(stubProvider("2099-01-01"));

    const { id } = await svc.addFromDiscover("movie", 42);
    const row = (await db.select().from(schema.movie).where(eq(schema.movie.id, id)))[0];
    expect(row.minimumAvailability).toBe("released");
  });

  it("defaults to 'announced' when TMDB's release date has already passed", async () => {
    const db = await freshDb();
    const config = new ConfigService(db);
    await config.upsert({ "metadata.tmdbApiKey": "test-key" });
    const movies = new MoviesService(db, new EventsService(new EventBus()));
    const series = new SeriesService(db, new EventsService(new EventBus()));
    const svc = new MetadataService(db, config, movies, series);
    vi.spyOn(svc, "provider").mockResolvedValue(stubProvider("2020-01-01"));

    const { id } = await svc.addFromDiscover("movie", 43);
    const row = (await db.select().from(schema.movie).where(eq(schema.movie.id, id)))[0];
    expect(row.minimumAvailability).toBe("announced");
  });

  it("defaults to 'announced' when TMDB has no release date at all", async () => {
    const db = await freshDb();
    const config = new ConfigService(db);
    await config.upsert({ "metadata.tmdbApiKey": "test-key" });
    const movies = new MoviesService(db, new EventsService(new EventBus()));
    const series = new SeriesService(db, new EventsService(new EventBus()));
    const svc = new MetadataService(db, config, movies, series);
    vi.spyOn(svc, "provider").mockResolvedValue(stubProvider(undefined));

    const { id } = await svc.addFromDiscover("movie", 44);
    const row = (await db.select().from(schema.movie).where(eq(schema.movie.id, id)))[0];
    expect(row.minimumAvailability).toBe("announced");
  });
});
