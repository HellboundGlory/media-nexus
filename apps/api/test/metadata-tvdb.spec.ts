// SPDX-License-Identifier: MIT
/** TheTVDB numbering backfill (roadmap P2, gap D8) — driven through refreshSeries(). */
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

/** A fully-stubbed TMDB provider returning a fixed series with two season-1 episodes. */
const fakeTmdb = {
  tmdbIdForTvdb: async () => "12345",
  getDetails: async () => ({ title: "Test Show", overview: "overview-set-by-tmdb", genres: ["Drama"], images: [], year: 2020 }),
  seriesSeasons: async () => [
    { season_number: 1, episodes: [
      { episode_number: 1, name: "E1", air_date: "2020-01-01", overview: "" },
      { episode_number: 2, name: "E2", air_date: "2020-01-08", overview: "" },
    ] },
  ],
};

/** TVDB numbering fixture: official S&E (matching the local TMDB rows) + absolute, and a
 *  dvd/scene ordering that diverges (ep 1 <-> scene S03E04, ep 2 <-> S03E05). */
const fakeTvdbOk = {
  episodes: async (tvdbId: number, seasonType: string) => {
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

async function seedSeries(seriesId: string, ids: { tvdbId: number; tmdbId: number }): Promise<void> {
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

function service(overrides: { tvdb?: object }): MetadataService {
  const svc = new MetadataService(db, new ConfigService(db), {} as never, {} as never) as MetadataService;
  (svc as unknown as { provider: () => Promise<typeof fakeTmdb> }).provider = async () => fakeTmdb;
  (svc as unknown as { tvdbProvider: () => Promise<{ episodes: (...a: unknown[]) => Promise<unknown> }> }).tvdbProvider = async () => (overrides.tvdb ?? fakeTvdbOk) as never;
  return svc;
}

describe("refreshSeries() TheTVDB numbering backfill", () => {
  it("backfills absolute + scene numbering from TVDB for matched episodes", async () => {
    await seedSeries("backfill", { tvdbId: 7, tmdbId: 12345 });
    await service({}).refreshSeries("backfill");

    const e1 = (await db.select().from(schema.episode).where(eq(schema.episode.id, "ep_backfill_1_1")))[0];
    const e2 = (await db.select().from(schema.episode).where(eq(schema.episode.id, "ep_backfill_1_2")))[0];
    expect(e1.absoluteNumber).toBe(5);
    expect(e1.sceneSeasonNumber).toBe(3);
    expect(e1.sceneEpisodeNumber).toBe(4);
    expect(e2.absoluteNumber).toBe(6);
    expect(e2.sceneSeasonNumber).toBe(3);
    expect(e2.sceneEpisodeNumber).toBe(5);
  });

  it("backs up alternate titles (TVDB aliases) onto the series row", async () => {
    await seedSeries("alias", { tvdbId: 9, tmdbId: 99901 });
    await service({}).refreshSeries("alias");

    const s = (await db.select().from(schema.series).where(eq(schema.series.id, "alias")))[0];
    expect(s.alternateTitles).toEqual(["AOT", "SNK"]);
  });

  it("still succeeds with TMDB fields intact when TVDB is unavailable (backfill no-ops)", async () => {
    await seedSeries("graceful", { tvdbId: 8, tmdbId: 54321 });
    const failingTvdb = { episodes: async () => { throw new Error("worker unreachable"); } };
    const result = await service({ tvdb: failingTvdb }).refreshSeries("graceful");

    expect(result.updated).toBe(true);
    expect(result.title).toBe("Test Show");
    const series = (await db.select().from(schema.series).where(eq(schema.series.id, "graceful")))[0];
    expect(series.overview).toBe("overview-set-by-tmdb"); // TMDB portion applied despite TVDB failure
    expect(series.alternateTitles ?? []).toEqual([]); // gracefully left empty
    const e1 = (await db.select().from(schema.episode).where(eq(schema.episode.id, "ep_graceful_1_1")))[0];
    expect(e1.absoluteNumber).toBeNull(); // gracefully left null
    expect(e1.sceneSeasonNumber).toBeNull();
  });
});
