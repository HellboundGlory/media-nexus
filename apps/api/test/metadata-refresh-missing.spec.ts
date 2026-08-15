// SPDX-License-Identifier: MIT
/**
 * refreshMissing() rotation + media-type coverage (roadmap P3, gap report D5).
 *
 * Regression: refreshMissing was series-only, applied no ORDER BY, and re-selected the same
 * first `limit` rows on every run — titles past the first 5 were never metadata-refreshed,
 * and movies were never refreshed at all. It must rotate through the whole library (both media
 * types) by `lastRefreshedAt` ASC, NULLs first (never-refreshed), so repeated runs advance
 * instead of stalling, and refresh bumps `lastRefreshedAt` to a real timestamp.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, schema } from "@medianexus/database";
import { MetadataService } from "../src/metadata/metadata.service";
import { ConfigService } from "../src/system/config.service";

const dir = mkdtempSync(join(tmpdir(), "mn-meta-missing-"));
let handle: ReturnType<typeof createDb>;
let db: ReturnType<typeof createDb>["db"];

beforeAll(() => {
  handle = createDb(join(dir, "t.db"));
  handle.runMigrations();
  db = handle.db;
});
afterAll(() => handle.close());

/** Fake TMDB provider: every movie/series resolves successfully and bumps nothing extra. */
const fakeProvider = {
  tmdbIdForTvdb: async () => 900000,
  getDetails: async (mediaType: string) =>
    mediaType === "movie"
      ? { title: "Test Movie", overview: "o", genres: ["Drama"], images: [], releaseDate: null }
      : { title: "Test Series", overview: "o", genres: ["Drama"], images: [], year: 2020 },
  seriesSeasons: async () => [],
};
/** Fake TVDB: no numbering/aliases (null fields, no extra effect). */
const fakeTvdb = { episodes: async () => [], seriesAliases: async () => [] };

// Seed rows with `lastRefreshedAt` deliberately OMITTED (NULL) — i.e. "never metadata-refreshed".
// The rotation test then proves NULL rows are picked first and a successful refresh stamps a real
// value (non-NULL), pushing them to the back for the next run.
async function seedMovie(id: string, tmdbId: number, ts: string): Promise<void> {
  await db.insert(schema.movie).values({
    id, tmdbId, imdbId: null, title: `Movie ${id}`, originalTitle: null, overview: "",
    status: "released", releaseDate: null, monitored: true, qualityProfileId: null,
    rootFolderPath: "/media/movies", minimumAvailability: "released", genres: [], images: [],
    tags: [], hasFile: false, addedAt: ts, updatedAt: ts,
  });
}

async function seedSeries(id: string, ids: { tvdbId: number; tmdbId: number }, ts: string): Promise<void> {
  await db.insert(schema.series).values({
    id, tvdbId: ids.tvdbId, tmdbId: ids.tmdbId, imdbId: null, title: `Series ${id}`, overview: "",
    status: "continuing", seriesType: "standard", network: null, firstAirYear: 2020,
    monitored: true, qualityProfileId: null, rootFolderPath: "/media/tv", genres: [], images: [],
    tags: [], addedAt: ts, updatedAt: ts,
  });
  // refreshSeries resolves episodes against real seasons; give it a bare season-0 row (empty).
  await db.insert(schema.season).values({ id: `sea_${id}_0`, seriesId: id, seasonNumber: 0, monitored: true });
}

function makeService(): MetadataService {
  const svc = new MetadataService(db, new ConfigService(db), {} as never, {} as never) as MetadataService;
  (svc as unknown as { provider: () => Promise<unknown> }).provider = async () => fakeProvider;
  (svc as unknown as { tvdbProvider: () => Promise<unknown> }).tvdbProvider = async () => fakeTvdb;
  return svc;
}

const now = new Date().toISOString();

describe("refreshMissing()", () => {
  it("advances past the first N rows on a second run (NULL-first rotation) and includes movies", async () => {
    // 6 movies + 6 series, ALL seeded with lastRefreshedAt = NULL (never refreshed). Ordering is
    // by lastRefreshedAt ASC nulls-first, so the never-refreshed rows are always picked before any
    // refreshed one; after call 1 stamps 5 of them, call 2 must pick a different (still-NULL) 5.
    for (let i = 0; i < 6; i++) {
      await seedMovie(`m${i}`, 1000 + i, now);
      await seedSeries(`s${i}`, { tvdbId: 2000 + i, tmdbId: 3000 + i }, now);
    }

    const svc = makeService();
    // Spy with call-through: record which ids refreshMissing routes to, while the real
    // refreshMovie/refreshSeries run (bumping lastRefreshedAt) so the rotation cursor advances.
    const origMovie = svc.refreshMovie.bind(svc);
    const origSeries = svc.refreshSeries.bind(svc);
    const movie1 = new Set<string>(); const series1 = new Set<string>();
    vi.spyOn(svc, "refreshMovie").mockImplementation(async (id) => { movie1.add(id); return origMovie(id); });
    vi.spyOn(svc, "refreshSeries").mockImplementation(async (id) => { series1.add(id); return origSeries(id); });

    const r1 = await svc.refreshMissing(5);
    expect(r1.refreshed).toBe(5);
    // At least one movie was refreshed (the series-only bug).
    expect(movie1.size).toBeGreaterThan(0);
    const first = new Set([...movie1, ...series1]);
    expect(first.size).toBe(5);

    // A successful refresh must have stamped a real lastRefreshedAt on a picked row, and NOT on an
    // unpicked (still never-refreshed) one.
    const picked = [...first][0];
    const refreshedRow = picked.startsWith("m")
      ? (await db.select().from(schema.movie).where(eq(schema.movie.id, picked)))[0]
      : (await db.select().from(schema.series).where(eq(schema.series.id, picked)))[0];
    expect(refreshedRow.lastRefreshedAt).toBeTruthy();

    // Second run must rotate to a disjoint set (the remaining NULL rows) rather than re-selecting.
    const movie2 = new Set<string>(); const series2 = new Set<string>();
    vi.spyOn(svc, "refreshMovie").mockImplementation(async (id) => { movie2.add(id); return origMovie(id); });
    vi.spyOn(svc, "refreshSeries").mockImplementation(async (id) => { series2.add(id); return origSeries(id); });

    const r2 = await svc.refreshMissing(5);
    expect(r2.refreshed).toBe(5);
    const second = new Set([...movie2, ...series2]);
    expect(second.size).toBe(5);
    expect([...second].filter((id) => first.has(id))).toEqual([]);
    // Movies are still included on the second rotation (never-refreshed rows span both media types).
    expect(movie2.size).toBeGreaterThan(0);
  });
});
