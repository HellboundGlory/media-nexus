// SPDX-License-Identifier: MIT
/**
 * SERIESSTATUS-2 — the Status field's frozen value is now refreshed from TMDB's real lifecycle
 * status on every metadata refresh (movie: "Released"/"Post Production"/"In Production"; series:
 * "Returning Series"/"Ended"/"Canceled"). refreshMovie/refreshSeries must persist the fetched
 * status verbatim into the DB row, and addFromDiscover's immediate post-add refresh means a
 * newly-added title gets a real status without waiting for a scheduled rotation.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "@medianexus/events";
import { createDb, schema } from "@medianexus/database";
import { MetadataService } from "../src/metadata/metadata.service";
import { ConfigService } from "../src/system/config.service";
import { MoviesService } from "../src/movies/movies.service";
import { SeriesService } from "../src/series/series.service";
import { AutoTagsService } from "../src/auto-tags/auto-tags.service";
import { EventsService } from "../src/events/events.service";

const dir = mkdtempSync(join(tmpdir(), "mn-status-refresh-"));
let handle: ReturnType<typeof createDb>;
let db: ReturnType<typeof createDb>["db"];
const eventBus = new EventBus();

beforeAll(() => {
  handle = createDb(join(dir, "t.db"));
  handle.runMigrations();
  db = handle.db;
});
afterAll(() => handle.close());

/** Fake TMDB provider returning a real status for movies (series status now comes from TVDB). */
async function makeMetadata(movies?: MoviesService, series?: SeriesService): Promise<MetadataService> {
  const fakeProvider = {
    tmdbIdForTvdb: async () => 900000,
    getDetails: async () =>
      ({ title: "Inception", overview: "o", genres: ["Sci-Fi"], images: [], releaseDate: "2010-07-16", status: "Released" }),
  };
  // TheTVDB is the series primary source: its extended record's status feeds refreshSeries.
  const fakeTvdb = {
    getDetails: async () => ({ externalId: "900001", title: "Breaking Bad", overview: "o", genres: ["Drama"], images: [], year: 2008, status: "Ended" }),
    seriesSeasons: async () => [],
    episodes: async () => [],
    seriesAliases: async () => [],
  };
  const events = new EventsService(eventBus);
  const autoTags = new AutoTagsService(db);
  const svc = new MetadataService(
    db,
    new ConfigService(db),
    movies ?? new MoviesService(db, events, autoTags, {} as never, {} as never, {} as never),
    series ?? new SeriesService(db, events, autoTags, {} as never, {} as never, {} as never),
    autoTags,
  );
  (svc as unknown as { provider: () => Promise<unknown> }).provider = async () => fakeProvider;
  (svc as unknown as { tvdbProvider: () => Promise<unknown> }).tvdbProvider = async () => fakeTvdb;
  return svc;
}

describe("refreshMovie (TMDB) / refreshSeries (TheTVDB) persist provider status (SERIESSTATUS-2)", () => {
  it("refreshMovie overwrites the placeholder status with TMDB's real value", async () => {
    await db.insert(schema.movie).values({
      id: "m1", tmdbId: 123, imdbId: null, title: "Inception", originalTitle: null, overview: "",
      status: "unknown", releaseDate: null, monitored: true, qualityProfileId: null,
      rootFolderPath: "/media/movies", minimumAvailability: "released", genres: [], images: [],
      tags: [], hasFile: false, addedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const svc = await makeMetadata();
    await svc.refreshMovie("m1");
    const row = (await db.select().from(schema.movie).where(eq(schema.movie.id, "m1")))[0];
    expect(row.status).toBe("Released");
  });

  it("refreshSeries overwrites the placeholder status with TheTVDB's real value", async () => {
    await db.insert(schema.series).values({
      id: "s1", tvdbId: 900001, tmdbId: 901, imdbId: null, title: "Breaking Bad", overview: "",
      status: "unknown", seriesType: "standard", network: null, firstAirYear: 2008,
      monitored: true, qualityProfileId: null, rootFolderPath: "/media/tv", genres: [], images: [],
      tags: [], addedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await db.insert(schema.season).values({ id: "sea_s1_0", seriesId: "s1", seasonNumber: 0, monitored: true });
    const svc = await makeMetadata();
    await svc.refreshSeries("s1");
    const row = (await db.select().from(schema.series).where(eq(schema.series.id, "s1")))[0];
    expect(row.status).toBe("Ended");
  });

  it("addFromDiscover gives a newly-added movie a real status immediately (post-add refresh)", async () => {
    const movies = new MoviesService(db, new EventsService(eventBus), new AutoTagsService(db), {} as never, {} as never, {} as never);
    const svc = await makeMetadata(movies);
    const res = await svc.addFromDiscover("movie", 27205); // Inception
    expect(res.created).toBe(true);
    const row = (await db.select().from(schema.movie).where(eq(schema.movie.tmdbId, 27205)))[0];
    expect(row.status).toBe("Released");
  });
});
