// SPDX-License-Identifier: MIT
/**
 * TheTVDB as the primary series metadata source (TVDB migration) — driven through refreshSeries().
 *
 * refreshSeries() sources overview/images/genres/status/certification/runtime AND the
 * season/episode upsert loop from TvdbProvider.getDetails()/seriesSeasons(); the row's tvdbId is
 * the primary id (no TMDB-resolution gate). series.tmdbId is best-effort backfilled off the TVDB
 * remoteIds first, with the legacy TMDB reverse-lookup as fallback, and cast/crew credits still
 * come from TMDB when an id is known. The additive numbering/alias backfills are unchanged.
 */
import { AutoTagsService } from "../src/auto-tags/auto-tags.service";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@medianexus/database";
import { MetadataService } from "../src/metadata/metadata.service";
import { ConfigService } from "../src/system/config.service";

const dir = mkdtempSync(join(tmpdir(), "mn-metatvdb-"));
let handle: ReturnType<typeof createDb>;
let db: ReturnType<typeof createDb>["db"];

beforeAll(async () => {
  handle = createDb(join(dir, "t.db"));
  handle.runMigrations();
  db = handle.db;
});
afterAll(() => handle.close());

/** Stubbed TMDB provider: only the pieces refreshSeries still uses for series — the tmdbId
 *  reverse-lookup fallback and (optionally) credits. getDetails is never called for series. */
const fakeTmdb = {
  tmdbIdForTvdb: async () => "12345",
  getCredits: async () => ({ cast: [], crew: [] }),
};

/** Full TVDB stub mirroring live shapes: details + official-order seasons/episodes (with a
 *  series finale marker), plus official/dvd orderings for the numbering backfill. */
function makeTvdb(over: { tmdbIdInRemoteIds?: boolean } = {}) {
  return {
    getDetails: async () => ({
      externalId: "7", title: "Test Show", overview: "overview-set-by-tvdb", year: 2020,
      status: "Ended", genres: ["Drama"], images: [{ coverType: "poster", url: "/p.jpg" }],
      certification: "TV-MA", runtime: 45,
      ...(over.tmdbIdInRemoteIds === false ? {} : { tmdbId: 555000 }),
    }),
    seriesSeasons: async () => [
      {
        seasonNumber: 1,
        episodes: [
          { episodeNumber: 1, name: "E1", airDate: "2020-01-01", overview: "", episodeType: undefined },
          { episodeNumber: 2, name: "E2", airDate: "2020-01-08", overview: "", episodeType: "finale" },
        ],
      },
    ],
    episodes: async (_tvdbId: number, seasonType: string) => {
      if (seasonType === "dvd") {
        return [
          { id: 101, seasonNumber: 3, number: 4, absoluteNumber: null, aired: null },
          { id: 102, seasonNumber: 3, number: 5, absoluteNumber: null, aired: null },
        ];
      }
      return [
        { id: 101, seasonNumber: 1, number: 1, absoluteNumber: 5, aired: "2020-01-01" },
        { id: 102, seasonNumber: 1, number: 2, absoluteNumber: 6, aired: "2020-01-08" },
      ];
    },
    seriesAliases: async () => ["AOT", "SNK"],
  };
}

async function seedSeries(seriesId: string, ids: { tvdbId: number | null; tmdbId: number | null }): Promise<void> {
  const now = new Date().toISOString();
  await db.insert(schema.series).values({
    id: seriesId, tvdbId: ids.tvdbId, tmdbId: ids.tmdbId, imdbId: null, title: "Test Show", overview: "",
    status: "continuing", seriesType: "anime", network: null, firstAirYear: 2020,
    monitored: true, qualityProfileId: null, rootFolderPath: "/media/tv", genres: [], images: [],
    tags: [], addedAt: now, updatedAt: now,
  });
  await db.insert(schema.season).values({ id: `sea_${seriesId}_1`, seriesId, seasonNumber: 1, monitored: true });
  await db.insert(schema.episode).values([
    { id: `ep_${seriesId}_1_1`, seriesId, seasonId: `sea_${seriesId}_1`, episodeNumber: 1, absoluteNumber: null, title: "", overview: "", airDateUtc: "2020-01-01", monitored: true, hasFile: false, sceneSeasonNumber: null, sceneEpisodeNumber: null },
    { id: `ep_${seriesId}_1_2`, seriesId, seasonId: `sea_${seriesId}_1`, episodeNumber: 2, absoluteNumber: null, title: "", overview: "", airDateUtc: "2020-01-08", monitored: true, hasFile: false, sceneSeasonNumber: null, sceneEpisodeNumber: null },
  ]);
}

function service(tvdb: object, tmdb: object = fakeTmdb): MetadataService {
  const svc = new MetadataService(db, new ConfigService(db), {} as never, {} as never, new AutoTagsService(db)) as MetadataService;
  (svc as unknown as { provider: () => Promise<object> }).provider = async () => tmdb;
  (svc as unknown as { tvdbProvider: () => Promise<object> }).tvdbProvider = async () => tvdb;
  return svc;
}

describe("refreshSeries() sourced from TheTVDB", () => {
  it("re-sources overview/status/certification/runtime and maps finaleType onto existing rows", async () => {
    await seedSeries("tvdbprimary", { tvdbId: 7, tmdbId: 12345 });
    const result = await service(makeTvdb()).refreshSeries("tvdbprimary");

    expect(result.updated).toBe(true);
    expect(result.title).toBe("Test Show");
    const s = (await db.select().from(schema.series).where(eq(schema.series.id, "tvdbprimary")))[0];
    expect(s.overview).toBe("overview-set-by-tvdb");
    expect(s.status).toBe("Ended");
    expect(s.certification).toBe("TV-MA");
    expect(s.runtime).toBe(45);
    // Pre-existing tmdbId is never overwritten (UNIQUE column), even though remoteIds had one.
    expect(s.tmdbId).toBe(12345);

    // EPISODEDETAIL-1: TVDB finaleType "series" -> our "finale"; regular episodes stay null.
    const e1 = (await db.select().from(schema.episode).where(eq(schema.episode.id, "ep_tvdbprimary_1_1")))[0];
    const e2 = (await db.select().from(schema.episode).where(eq(schema.episode.id, "ep_tvdbprimary_1_2")))[0];
    expect(e1.episodeType).toBeNull();
    expect(e2.episodeType).toBe("finale");
  });

  it("backfills tmdbId from TVDB remoteIds when the row has none", async () => {
    await seedSeries("remoteids", { tvdbId: 8, tmdbId: null });
    await service(makeTvdb()).refreshSeries("remoteids");
    const s = (await db.select().from(schema.series).where(eq(schema.series.id, "remoteids")))[0];
    expect(s.tmdbId).toBe(555000);
  });

  it("falls back to the TMDB reverse-lookup when remoteIds carry no TMDB entry", async () => {
    await seedSeries("fallback", { tvdbId: 9, tmdbId: null });
    // Distinct id: another row in this shared DB already claims fakeTmdb's default 12345, and the
    // UNIQUE-conflict guard must skip (not crash) — asserted separately below.
    const tmdb = { ...fakeTmdb, tmdbIdForTvdb: async () => "77777" };
    await service(makeTvdb({ tmdbIdInRemoteIds: false }), tmdb).refreshSeries("fallback");
    const s = (await db.select().from(schema.series).where(eq(schema.series.id, "fallback")))[0];
    expect(s.tmdbId).toBe(77777); // from tmdb.tmdbIdForTvdb
  });

  it("skips the tmdbId backfill without failing the refresh when another series already owns that TMDB id", async () => {
    await seedSeries("clash", { tvdbId: 13, tmdbId: null });
    await service(makeTvdb({ tmdbIdInRemoteIds: false })).refreshSeries("clash"); // reverse-lookup says 12345 — claimed by "tvdbprimary"
    const s = (await db.select().from(schema.series).where(eq(schema.series.id, "clash")))[0];
    expect(s.tmdbId).toBeNull();
    const fresh = (await db.select().from(schema.series).where(eq(schema.series.id, "clash")))[0];
    expect(fresh.overview).toBe("overview-set-by-tvdb"); // the refresh itself still applied
  });

  it("backs up alternate titles (TVDB aliases) onto the series row and scene numbers from DVD ordering", async () => {
    await seedSeries("alias", { tvdbId: 10, tmdbId: 99901 });
    await service(makeTvdb()).refreshSeries("alias");

    const s = (await db.select().from(schema.series).where(eq(schema.series.id, "alias")))[0];
    expect(s.alternateTitles).toEqual(["AOT", "SNK"]);
    const e1 = (await db.select().from(schema.episode).where(eq(schema.episode.id, "ep_alias_1_1")))[0];
    expect(e1.absoluteNumber).toBe(5);
    expect(e1.sceneSeasonNumber).toBe(3);
    expect(e1.sceneEpisodeNumber).toBe(4);
  });

  it("still succeeds when TMDB is unreachable (backfill/credits are best-effort only)", async () => {
    await seedSeries("graceful", { tvdbId: 11, tmdbId: null });
    const failingTmdb = {
      tmdbIdForTvdb: async () => { throw new Error("tmdb unreachable"); },
      getCredits: async () => { throw new Error("tmdb unreachable"); },
    };
    const result = await service(makeTvdb({ tmdbIdInRemoteIds: false }), failingTmdb).refreshSeries("graceful");

    expect(result.updated).toBe(true);
    const s = (await db.select().from(schema.series).where(eq(schema.series.id, "graceful")))[0];
    expect(s.overview).toBe("overview-set-by-tvdb"); // TVDB portion applied despite TMDB failure
    expect(s.tmdbId).toBeNull(); // backfill skipped, not fatal
  });

  it("fails when TVDB is unavailable (it is now the primary source, not an additive extra)", async () => {
    await seedSeries("hardfail", { tvdbId: 12, tmdbId: 54321 });
    const failingTvdb = {
      getDetails: async () => { throw new Error("worker unreachable"); },
      seriesSeasons: async () => { throw new Error("worker unreachable"); },
      episodes: async () => { throw new Error("worker unreachable"); },
      seriesAliases: async () => [],
    };
    await expect(service(failingTvdb).refreshSeries("hardfail")).rejects.toThrow("worker unreachable");
  });

  it("rejects a series without any tvdbId (TVDB needs its own id now)", async () => {
    await seedSeries("notvid", { tvdbId: null, tmdbId: 777 });
    await expect(service(makeTvdb()).refreshSeries("notvid")).rejects.toThrow(/no tvdbId/);
  });
});
