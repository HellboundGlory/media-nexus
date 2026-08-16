// SPDX-License-Identifier: MIT
/**
 * QUALITYPROFILES-1 (UNI-014/UNI-015, 2026-08-16 audit): the regression test that proves the
 * Discover add path can now assign a real, decision-engine-`consumed quality profile.
 *
 * The whole defect this task fixes is that every UI-added title got qualityProfileId: null,
 * which `profileAllowedSpecification` treats as "unrestricted". So the proof of the fix is NOT
 * "the form submits" — it is that a title added through MetadataService.addFromDiscover() with
 * an overrides qualityProfileId (a) persists that id on the row, and (b) that a release outside
 * the profile's allowed qualities is actually REJECTED by packages/domain/src/decision.ts's
 * profileAllowedSpecification (with the profile loaded the same way DecisionService loads it,
 * via getQualityProfile). Together those prove the cutoff/upgrade machinery is gated again, not
 * just that a dropdown exists. The same overrides (rootFolderPath/tags/seriesType) are asserted
 * to land on the created row for the series branch.
 *
 * Written first and confirmed to FAIL against the pre-fix addFromDiscover (which hardcoded
 * rootFolderPath:"" / tags:[] / seriesType:"standard" and never accepted a qualityProfileId):
 * under vitest's esbuild transform the extra overrides arg is ignored at runtime, so the added
 * row's qualityProfileId is null, getQualityProfile(null) is null, and the 2160p release is
 * approved — every assertion below fails.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { EventBus } from "@medianexus/events";
import { createDb, schema } from "@medianexus/database";
import { evaluate, qualityId, type Release, type DecisionContext } from "@medianexus/domain";
import { MoviesService } from "../src/movies/movies.service";
import { SeriesService } from "../src/series/series.service";
import { MetadataService } from "../src/metadata/metadata.service";
import { AutoTagsService } from "../src/auto-tags/auto-tags.service";
import { EventsService } from "../src/events/events.service";
import { ConfigService } from "../src/system/config.service";
import { getQualityProfile } from "../src/media/library.helpers";
import type { TmdbProvider } from "@medianexus/integrations";

const dir = mkdtempSync(join(tmpdir(), "mn-qp-gate-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });

let counter = 0;
async function freshDb() {
  const handle = createDb(join(dir, `qp-${counter++}.db`));
  handle.runMigrations();
  handles.push(handle);
  return handle.db;
}

function release(over: Partial<Release> = {}): Release {
  return {
    id: "r1", indexerId: "idx1", indexerName: "Demo", title: "Any.Title.2020.2160p.WEB-DL",
    protocol: "torrent", categories: [], size: 1000, ageHours: 1, seeders: 10, leechers: 1,
    quality: { source: "web", resolution: "2160p", edition: "" },
    isFreeleech: false, isProper: false, isRepack: false,
    ...over,
  };
}

/** A restrictive profile: ONLY web/720p allowed, cutoff at web/720p. Any 1080p/2160p release must be rejected. */
const RESTRICTIVE_PROFILE = {
  id: "qp_restrictive",
  name: "720p Only",
  items: [qualityId({ source: "web", resolution: "720p", edition: "" })],
  cutoffQualityId: qualityId({ source: "web", resolution: "720p", edition: "" }),
  upgradeAllowed: true,
  language: "en",
  isDefault: false,
  formatScores: {},
  minFormatScore: 0,
  cutoffFormatScore: 0,
};

async function seedRestrictiveProfile(db: Awaited<ReturnType<typeof freshDb>>): Promise<void> {
  await db.insert(schema.qualityProfile).values({
    ...RESTRICTIVE_PROFILE,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

function stubProvider(title: string): TmdbProvider {
  return {
    getDetails: async () => ({ externalId: "1", title, releaseDate: "2020-01-01", overview: "", genres: [], images: [] }),
    tvdbIdForTmdb: async () => "234567",
    tmdbIdForTvdb: async () => "234567",
    seriesSeasons: async () => [],
  } as unknown as TmdbProvider;
}

/** A no-op TheTVDB stub so the post-add series refresh never touches the network. */
function stubTvdb() {
  return { episodes: async () => [], seriesAliases: async () => [] } as never;
}

function buildSvc(db: Awaited<ReturnType<typeof freshDb>>) {
  const config = new ConfigService(db);
  return {
    config,
    movies: new MoviesService(db, new EventsService(new EventBus()), new AutoTagsService(db)),
    series: new SeriesService(db, new EventsService(new EventBus()), new AutoTagsService(db)),
  };
}

describe("MetadataService.addFromDiscover() — quality profile + overrides (UNI-014 regression)", () => {
  it("persists a qualityProfileId from overrides AND the decision engine rejects an out-of-profile release", async () => {
    const db = await freshDb();
    await seedRestrictiveProfile(db);
    const { config, movies, series } = buildSvc(db);
    await config.upsert({ "metadata.tmdbApiKey": "test-key" });
    const svc = new MetadataService(db, config, movies, series, new AutoTagsService(db));
    vi.spyOn(svc, "provider").mockResolvedValue(stubProvider("Discover Movie"));

    const { id } = await svc.addFromDiscover("movie", 4242, {
      qualityProfileId: "qp_restrictive",
      rootFolderPath: "/media/movies",
      tags: ["favorite"],
    });

    // (a) the id actually landed on the created row — the pre-fix code never set it.
    const row = (await db.select().from(schema.movie).where(eq(schema.movie.id, id)))[0];
    expect(row.qualityProfileId).toBe("qp_restrictive");
    expect(row.rootFolderPath).toBe("/media/movies");
    expect(row.tags).toEqual(["favorite"]);

    // (b) load the profile the way DecisionService does and prove the engine is gated:
    // an out-of-profile 2160p release is rejected with not_allowed_by_profile.
    const profile = await getQualityProfile(db, row.qualityProfileId);
    expect(profile).not.toBeNull();
    const ctx: DecisionContext = {
      target: { kind: "movie", mediaType: "movie", mediaId: id },
      profile, existingFiles: [], isBlocklisted: false, hasActiveQueueConflict: false,
      preferredProtocol: "any", freeSpaceBytes: null, minimumFreeSpaceMb: 100,
    };
    const d = evaluate(release(), ctx); // web/2160p, not in the 720p-only profile
    expect(d.rejections.map((r) => r.reason)).toContain("not_allowed_by_profile");
    expect(d.approved).toBe(false);
  });

  it("applies seriesType/tags/rootFolderPath overrides on the series branch", async () => {
    const db = await freshDb();
    await seedRestrictiveProfile(db);
    const { config, movies, series } = buildSvc(db);
    await config.upsert({ "metadata.tmdbApiKey": "test-key" });
    const svc = new MetadataService(db, config, movies, series, new AutoTagsService(db));
    vi.spyOn(svc, "provider").mockResolvedValue(stubProvider("Discover Series"));
    vi.spyOn(svc, "tvdbProvider").mockResolvedValue(stubTvdb());

    const { id } = await svc.addFromDiscover("series", 100600, {
      qualityProfileId: "qp_restrictive",
      rootFolderPath: "/media/tv",
      tags: ["anime"],
      seriesType: "anime",
      monitored: false,
    });

    const row = (await db.select().from(schema.series).where(eq(schema.series.id, id)))[0];
    expect(row.qualityProfileId).toBe("qp_restrictive");
    expect(row.rootFolderPath).toBe("/media/tv");
    expect(row.tags).toEqual(["anime"]);
    expect(row.seriesType).toBe("anime");
    // The add-modal's `monitored` checkbox must actually round-trip (regression: the pre-fix
    // addFromDiscover hardcoded monitored:true and discoverAddBody stripped unknown keys).
    expect(row.monitored).toBe(false);
  });
});
