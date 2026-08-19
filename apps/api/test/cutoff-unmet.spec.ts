// SPDX-License-Identifier: MIT
/**
 * NAV-1 Phase 0 — GET /wanted/cutoff-unmet backend. Proves the cutoff filter uses the shared
 * `meetsCutoff()` (not a reimplementation): only monitored titles WITH a file whose quality is
 * below (or outside) their profile cutoff are returned, for both movies and series. Written
 * against the two services' `cutoffUnmet()` methods (the controller is a thin merge of them,
 * exactly like `wanted/missing`).
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "@medianexus/events";
import { createDb, schema } from "@medianexus/database";
import { qualityId, type Quality } from "@medianexus/domain";
import { MoviesService } from "../src/movies/movies.service";
import { SeriesService } from "../src/series/series.service";
import { AutoTagsService } from "../src/auto-tags/auto-tags.service";
import { EventsService } from "../src/events/events.service";

const dir = mkdtempSync(join(tmpdir(), "mn-cutoff-unmet-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });

let counter = 0;
let tvCounter = 0;
async function freshDb() {
  const handle = createDb(join(dir, `cu-${counter++}.db`));
  handle.runMigrations();
  handles.push(handle);
  return handle.db;
}

// Profile: allows 720p/1080p/2160p, cutoff at web/1080p — so any held file below 1080p is unmet.
const CUTOFF_PROFILE = {
  id: "qp_cutoff",
  name: "Cutoff",
  items: [qualityId(q("hdtv", "720p")), qualityId(q("web", "1080p")), qualityId(q("bluray", "2160p"))],
  cutoffQualityId: qualityId(q("web", "1080p")),
};
function q(source: string, resolution: string): Quality {
  return { source: source as Quality["source"], resolution: resolution as Quality["resolution"], edition: "" };
}

async function seedProfile<T extends { id: string; name: string; items: number[]; cutoffQualityId: number }>(db: Awaited<ReturnType<typeof freshDb>>, p: T) {
  await db.insert(schema.qualityProfile).values({
    id: p.id, name: p.name, items: p.items, cutoffQualityId: p.cutoffQualityId,
    upgradeAllowed: true, language: "en", isDefault: false, formatScores: {},
    minFormatScore: 0, cutoffFormatScore: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
}

function movieRow(over: Record<string, unknown>): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id: "m", tmdbId: null, imdbId: null, title: "T", overview: "", status: "released", releaseDate: "2020-01-01",
    monitored: true, qualityProfileId: null, rootFolderPath: "", folderName: null, genres: [], images: [], tags: [],
    hasFile: false, addedAt: now, updatedAt: now, ...over,
  };
}

function fileRow(over: Record<string, unknown>): Record<string, unknown> {
  return { id: "mf", mediaType: "movie", mediaId: "m", relativePath: "x.mkv", size: 1000, dateAdded: "2020-01-01T00:00:00.000Z", ...over };
}

describe("MoviesService.cutoffUnmet()", () => {
  async function svc(db: Awaited<ReturnType<typeof freshDb>>) {
    return new MoviesService(db, new EventsService(new EventBus()), new AutoTagsService(db));
  }

  it("returns a monitored movie whose held file is below the cutoff, and skips at/above it", async () => {
    const db = await freshDb();
    await seedProfile(db, CUTOFF_PROFILE);
    const s = await svc(db);
    // below cutoff (SD/480p)
    await db.insert(schema.movie).values(movieRow({ id: "m_below", title: "Below", qualityProfileId: "qp_cutoff", hasFile: true }) as never);
    await db.insert(schema.mediaFile).values(fileRow({ id: "mf_below", mediaId: "m_below", quality: q("sd", "480p") }) as never);
    // at cutoff (web/1080p) — must NOT appear
    await db.insert(schema.movie).values(movieRow({ id: "m_met", title: "Met", qualityProfileId: "qp_cutoff", hasFile: true }) as never);
    await db.insert(schema.mediaFile).values(fileRow({ id: "mf_met", mediaId: "m_met", quality: q("web", "1080p") }) as never);

    const unmet = await s.cutoffUnmet();
    expect(unmet.candidates.map((m) => m.id)).toEqual(["m_below"]);
    expect(unmet.candidates[0].quality).toEqual(q("sd", "480p"));
    expect(unmet.candidates[0].cutoffQualityId).toBe(CUTOFF_PROFILE.cutoffQualityId);
  });

  it("ignores unmonitored titles and titles with no assigned profile", async () => {
    const db = await freshDb();
    await seedProfile(db, CUTOFF_PROFILE);
    const s = await svc(db);
    await db.insert(schema.movie).values(movieRow({ id: "m_unmon", title: "Unmon", qualityProfileId: "qp_cutoff", hasFile: true, monitored: false }) as never);
    await db.insert(schema.mediaFile).values(fileRow({ id: "mf_unmon", mediaId: "m_unmon", quality: q("sd", "480p") }) as never);
    await db.insert(schema.movie).values(movieRow({ id: "m_noprofile", title: "NoProfile", qualityProfileId: null, hasFile: true }) as never);
    await db.insert(schema.mediaFile).values(fileRow({ id: "mf_noprof", mediaId: "m_noprofile", quality: q("sd", "480p") }) as never);

    expect((await s.cutoffUnmet()).candidates).toEqual([]);
  });

  it("judges by the BEST held file", async () => {
    const db = await freshDb();
    await seedProfile(db, CUTOFF_PROFILE);
    const s = await svc(db);
    // two files: one below cutoff, one at cutoff — the best (at cutoff) governs, so NOT unmet
    await db.insert(schema.movie).values(movieRow({ id: "m_two", title: "Two", qualityProfileId: "qp_cutoff", hasFile: true }) as never);
    await db.insert(schema.mediaFile).values(fileRow({ id: "mf_low", mediaId: "m_two", quality: q("sd", "480p") }) as never);
    await db.insert(schema.mediaFile).values(fileRow({ id: "mf_high", mediaId: "m_two", quality: q("web", "1080p") }) as never);

    expect((await s.cutoffUnmet()).candidates).toEqual([]);
  });
});

describe("SeriesService.cutoffUnmet()", () => {
  async function svc(db: Awaited<ReturnType<typeof freshDb>>) {
    return new SeriesService(db, new EventsService(new EventBus()), new AutoTagsService(db));
  }

  async function seedSeriesWithEpisode(db: Awaited<ReturnType<typeof freshDb>>, over: {
    seriesId?: string; profileId?: string | null; epId?: string; quality?: Quality; monitored?: boolean;
  }) {
    const seriesId = over.seriesId ?? "s1";
    await db.insert(schema.series).values({
      id: seriesId, tvdbId: ++tvCounter, tmdbId: null, imdbId: null, title: "Show", overview: "", status: "unknown",
      seriesType: "standard", network: null, firstAirYear: 2020, monitored: true,
      qualityProfileId: over.profileId ?? null, rootFolderPath: "", folderName: null,
      genres: [], images: [], tags: [], addedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as never);
    await db.insert(schema.season).values({ id: `${seriesId}_sea`, seriesId, seasonNumber: 1, monitored: true } as never);
    const epId = over.epId ?? "e1";
    // media_file is polymorphic (no FK to movie/series), but episode.media_file_id FK-references
    // it — so the file must exist before the episode row.
    await db.insert(schema.mediaFile).values({
      id: `mf_${epId}`, mediaType: "series", mediaId: seriesId, relativePath: `Season 1/${epId}.mkv`,
      size: 1000, dateAdded: "2020-01-01T00:00:00.000Z", quality: over.quality ?? q("sd", "480p"),
    } as never);
    await db.insert(schema.episode).values({
      id: epId, seriesId, seasonId: `${seriesId}_sea`, episodeNumber: 1, title: "Ep", overview: "",
      airDateUtc: "2020-01-01", monitored: over.monitored ?? true, hasFile: true, mediaFileId: `mf_${epId}`,
    } as never);
  }

  it("returns a monitored episode below the series cutoff and skips one at/above it", async () => {
    const db = await freshDb();
    await seedProfile(db, CUTOFF_PROFILE);
    const s = await svc(db);
    await seedSeriesWithEpisode(db, { seriesId: "s1", profileId: "qp_cutoff", epId: "e_below", quality: q("hdtv", "720p") });
    await seedSeriesWithEpisode(db, { seriesId: "s2", profileId: "qp_cutoff", epId: "e_met", quality: q("web", "1080p") });

    const unmet = await s.cutoffUnmet();
    expect(unmet.candidates.map((e) => e.id)).toEqual(["e_below"]);
    expect(unmet.candidates[0].seriesTitle).toBe("Show");
    expect(unmet.candidates[0].quality).toEqual(q("hdtv", "720p"));
    expect(unmet.candidates[0].cutoffQualityId).toBe(CUTOFF_PROFILE.cutoffQualityId);
  });

  it("ignores unmonitored episodes and series without a profile", async () => {
    const db = await freshDb();
    await seedProfile(db, CUTOFF_PROFILE);
    const s = await svc(db);
    await seedSeriesWithEpisode(db, { seriesId: "s1", profileId: "qp_cutoff", epId: "e_unmon", monitored: false, quality: q("sd", "480p") });
    await seedSeriesWithEpisode(db, { seriesId: "s2", profileId: null, epId: "e_noprofile", quality: q("sd", "480p") });

    expect((await s.cutoffUnmet()).candidates).toEqual([]);
  });
});
