// SPDX-License-Identifier: MIT
/**
 * WANTEDMISSING-1 — regression test for the wanted/missing (and cutoff-unmet) merge.
 *
 * The controller merges per-media-type results (series.wantedMissing + movies.wantedMissing),
 * date-sorts, and slices to `limit`. That merge must not let one media type's backlog hide the
 * other entirely: a single missing movie must still appear even when a large, chronologically
 * OLDER episode backlog exceeds the page limit. Fixed via symmetric fair-share slot allocation
 * (allocateSlots) — each media type gets at least half the limit (or all it has).
 *
 * Tested at the full controller level against a real seeded SQLite DB (the same harness the
 * wanted services are unit-tested with), because the bug lives in the controller's merge.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "@medianexus/events";
import { createDb, schema } from "@medianexus/database";
import { MoviesService } from "../src/movies/movies.service";
import { SeriesService } from "../src/series/series.service";
import { WantedController } from "../src/series/wanted.controller";
import { AutoTagsService } from "../src/auto-tags/auto-tags.service";
import { EventsService } from "../src/events/events.service";

const dir = mkdtempSync(join(tmpdir(), "mn-wanted-merge-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });

let counter = 0;
let tvCounter = 0;
async function freshDb() {
  const handle = createDb(join(dir, `wm-${counter++}.db`));
  handle.runMigrations();
  handles.push(handle);
  return handle.db;
}

// repo is only used by the calendar routes, not wanted/cutoff — a stub is fine.
async function harness(db: Awaited<ReturnType<typeof freshDb>>) {
  const series = new SeriesService(db, new EventsService(new EventBus()), new AutoTagsService(db));
  const movies = new MoviesService(db, new EventsService(new EventBus()), new AutoTagsService(db));
  const controller = new WantedController(series, movies, {} as never);
  return { series, movies, controller };
}

function movieRow(over: Record<string, unknown>): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id: "m", tmdbId: null, imdbId: null, title: "T", overview: "", status: "released",
    minimumAvailability: "released", releaseDate: "2024-01-01", monitored: true, qualityProfileId: null,
    rootFolderPath: "", folderName: null, genres: [], images: [], tags: [], hasFile: false,
    addedAt: now, updatedAt: now, ...over,
  };
}

/** Seed a monitored series + season with `count` monitored, file-less episodes whose air dates
 *  are all old (2020) — a backlog chronologically EARLIER than a newer movie. */
async function seedOldEpisodeBacklog(db: Awaited<ReturnType<typeof freshDb>>, count: number) {
  const seriesId = `s${++tvCounter}`;
  await db.insert(schema.series).values({
    id: seriesId, tvdbId: tvCounter, tmdbId: null, imdbId: null, title: "Old Show", overview: "", status: "unknown",
    seriesType: "standard", network: null, firstAirYear: 2020, monitored: true, qualityProfileId: null,
    rootFolderPath: "", folderName: null, genres: [], images: [], tags: [],
    addedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } as never);
  await db.insert(schema.season).values({ id: `${seriesId}_sea`, seriesId, seasonNumber: 1, monitored: true } as never);
  for (let i = 1; i <= count; i++) {
    await db.insert(schema.episode).values({
      id: `e${seriesId}_${i}`, seriesId, seasonId: `${seriesId}_sea`, episodeNumber: i, title: `Ep ${i}`,
      overview: "", airDateUtc: "2020-01-01", monitored: true, hasFile: false,
    } as never);
  }
  return seriesId;
}

describe("GET /wanted/missing merge (WANTEDMISSING-1)", () => {
  it("keeps a missing movie visible even when an older episode backlog exceeds the limit", async () => {
    const db = await freshDb();
    const { controller } = await harness(db);
    // >limit missing episodes (60 > default 50), all airing 2020 — OLDER than the movie.
    await seedOldEpisodeBacklog(db, 60);
    // One monitored, file-less, released movie with a NEWER release date (2024).
    await db.insert(schema.movie).values(movieRow({ id: "m_recent", title: "Recent Movie" }) as never);

    const res = await controller.wanted({ limit: 50 });
    const movieIds = res.items.filter((r) => r.mediaType === "movie").map((r) => r.id);
    // The movie must appear even though the 60-episode backlog is older and fills the list.
    expect(movieIds).toContain("m_recent");
    expect(res.items.length).toBeLessThanOrEqual(50);
  });

  it("leaves the natural date-sorted union unchanged when neither type is starved", async () => {
    const db = await freshDb();
    const { controller } = await harness(db);
    // Small library: 3 episodes + 2 movies, all well under half the limit — nothing to reallocate.
    await seedOldEpisodeBacklog(db, 3);
    await db.insert(schema.movie).values(movieRow({ id: "m_a", title: "A", releaseDate: "2022-01-01" }) as never);
    await db.insert(schema.movie).values(movieRow({ id: "m_b", title: "B", releaseDate: "2023-01-01" }) as never);

    const res = await controller.wanted({ limit: 50 });
    expect(res.items.map((r) => r.id)).toHaveLength(5); // 3 episodes + 2 movies, none dropped
    expect(res.items.filter((r) => r.mediaType === "series")).toHaveLength(3);
    expect(res.items.filter((r) => r.mediaType === "movie")).toHaveLength(2);
  });

  it("series.wantedMissing overfetches past the limit so it can fill leftover slots", async () => {
    const db = await freshDb();
    const { series } = await harness(db);
    const seriesId = await seedOldEpisodeBacklog(db, 60);
    const epIds = (await series.wantedMissing(50)).candidates.map((e) => e.id as string);
    // It must return more than `limit` candidates (headroom for the allocation), all from the seed.
    expect(epIds.length).toBeGreaterThan(50);
    expect(epIds.every((id) => id.startsWith(`e${seriesId}_`))).toBe(true);
  });
});

describe("GET /wanted/cutoff-unmet merge (WANTEDMISSING-1)", () => {
  it("applies the same fair-share allocation so the series side can't be hidden by a movie backlog", async () => {
    const db = await freshDb();
    const { controller } = await harness(db);
    await seedProfile(db, { id: "qp_low", name: "Low", items: [1, 2], cutoffQualityId: 2 });
    // One unmet episode (newer air date) is the only series-side row.
    await seedUnmetEpisode(db, "2024-01-01");
    // 60 below-cutoff movies with OLDER release dates (2019) dominate the cutoff list by count+date.
    for (let i = 0; i < 60; i++) {
      await db.insert(schema.movie).values(movieRow({
        id: `m_cut_${i}`, title: `Cut ${i}`, qualityProfileId: "qp_low", hasFile: true, releaseDate: "2019-01-01",
      }) as never);
      await db.insert(schema.mediaFile).values({
        id: `mf_cut_${i}`, mediaType: "movie", mediaId: `m_cut_${i}`, relativePath: `${i}.mkv`, size: 1000,
        dateAdded: "2019-01-01T00:00:00.000Z", quality: { source: "sd", resolution: "480p", edition: "" },
      } as never);
    }

    const res = await controller.cutoffUnmet({ limit: 50 });
    // The lone unmet episode must be present despite the 60-older-movie backlog.
    expect(res.items.filter((r) => r.mediaType === "series").map((r) => r.id)).toContain("e_unmet");
    expect(res.items.length).toBeLessThanOrEqual(50);
  });
});

describe("GET /wanted/missing cross-page keyset pagination (WANTEDPAGE-1)", () => {
  it("keeps both media types represented on every page and returns every row exactly once across pages", async () => {
    const db = await freshDb();
    const { controller } = await harness(db);
    // More than one page's worth of BOTH types: 6 old episodes + 6 movies, small limit=4 so the
    // fair-share split (base 2 each) leaves both types with candidates remaining past page 1.
    const seriesId = await seedOldEpisodeBacklog(db, 6);
    for (let i = 1; i <= 6; i++) {
      await db.insert(schema.movie).values(movieRow({
        id: `m_page_${i}`, title: `Page Movie ${i}`, releaseDate: `2025-01-0${i}`,
      }) as never);
    }

    const page1 = await controller.wanted({ limit: 4 });
    expect(page1.items).toHaveLength(4);
    // Page 1 fair-share: 2 episodes + 2 movies (base = floor(4/2)).
    expect(page1.items.filter((r) => r.mediaType === "series")).toHaveLength(2);
    expect(page1.items.filter((r) => r.mediaType === "movie")).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBeTruthy();

    // Page 2 must STILL represent both media types (the true WANTEDPAGE-1 regression, not just
    // page 1), and no row may be duplicated or dropped across the two pages.
    const page2 = await controller.wanted({ limit: 4, cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(4);
    expect(page2.items.some((r) => r.mediaType === "series")).toBe(true);
    expect(page2.items.some((r) => r.mediaType === "movie")).toBe(true);

    const allIds = [...page1.items, ...page2.items].map((r) => r.id);
    expect(new Set(allIds).size).toBe(allIds.length); // no duplicates across pages

    // Final page: the remaining 2 episodes + 2 movies must surface with no gaps (no row skipped
    // because a cursor overshot), and pagination must terminate.
    const page3 = await controller.wanted({ limit: 4, cursor: page2.nextCursor! });
    expect(page3.items).toHaveLength(4);
    expect(page3.hasMore).toBe(false);

    const everything = [...page1.items, ...page2.items, ...page3.items];
    const movieIds = everything.filter((r) => r.mediaType === "movie").map((r) => r.id);
    const episodeIds = everything.filter((r) => r.mediaType === "series").map((r) => r.id);
    expect(episodeIds.sort()).toEqual(["e" + seriesId + "_1", "e" + seriesId + "_2", "e" + seriesId + "_3", "e" + seriesId + "_4", "e" + seriesId + "_5", "e" + seriesId + "_6"].sort());
    expect(movieIds.sort()).toEqual(["m_page_1", "m_page_2", "m_page_3", "m_page_4", "m_page_5", "m_page_6"]);
  });

  it("rejects a corrupted cursor with a validation error rather than silently resetting", async () => {
    const db = await freshDb();
    const { controller } = await harness(db);
    await db.insert(schema.movie).values(movieRow({ id: "m_a", title: "A" }) as never);
    await expect(controller.wanted({ limit: 50, cursor: "not-base64-json!!" })).rejects.toThrow("invalid cursor");
    // A well-formed-looking cursor with the wrong shape must also fail loudly.
    const bogus = Buffer.from(JSON.stringify({ m: { d: 5 }, e: "oops" })).toString("base64");
    await expect(controller.wanted({ limit: 50, cursor: bogus })).rejects.toThrow("invalid cursor");
  });
});

// --- helpers ---

async function seedUnmetEpisode(db: Awaited<ReturnType<typeof freshDb>>, airDateUtc: string) {
  const seriesId = "s_unmet";
  await db.insert(schema.series).values({
    id: seriesId, tvdbId: ++tvCounter, tmdbId: null, imdbId: null, title: "Unmet Show", overview: "", status: "unknown",
    seriesType: "standard", network: null, firstAirYear: 2020, monitored: true, qualityProfileId: "qp_low",
    rootFolderPath: "", folderName: null, genres: [], images: [], tags: [],
    addedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } as never);
  await db.insert(schema.season).values({ id: `${seriesId}_sea`, seriesId, seasonNumber: 1, monitored: true } as never);
  await db.insert(schema.mediaFile).values({
    id: "mf_unmet", mediaType: "series", mediaId: seriesId, relativePath: "s1/e1.mkv", size: 1000,
    dateAdded: "2020-01-01T00:00:00.000Z", quality: { source: "sd", resolution: "480p", edition: "" },
  } as never);
  await db.insert(schema.episode).values({
    id: "e_unmet", seriesId, seasonId: `${seriesId}_sea`, episodeNumber: 1, title: "Ep", overview: "",
    airDateUtc, monitored: true, hasFile: true, mediaFileId: "mf_unmet",
  } as never);
}

async function seedProfile<T extends { id: string; name: string; items: number[]; cutoffQualityId: number }>(
  db: Awaited<ReturnType<typeof freshDb>>,
  p: T,
) {
  await db.insert(schema.qualityProfile).values({
    id: p.id, name: p.name, items: p.items, cutoffQualityId: p.cutoffQualityId,
    upgradeAllowed: true, language: "en", isDefault: false, formatScores: {},
    minFormatScore: 0, cutoffFormatScore: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } as never);
}
