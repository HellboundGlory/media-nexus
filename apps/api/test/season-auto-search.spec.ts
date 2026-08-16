// SPDX-License-Identifier: MIT
/**
 * DETAILPAGE-FE2 — season-level auto-search endpoint regression test.
 *
 * POST /api/v1/series/:id/seasons/:seasonNumber/auto-search loops the same
 * search → title-match → pickBest → grab composition over every episode of the season that
 * does not already have a file, and returns a per-episode summary. Tested through the real
 * SeriesController + real SeriesService over a real SQLite DB (createDb/runMigrations, per
 * project convention) with only the external indexer seam stubbed — the same manner
 * grab-release.spec.ts drives IndexersController. Verifies the core behaviors: missing
 * episodes are attempted, episodes that already have a file are skipped, other seasons are
 * left alone, per-episode outcomes are reported, and grabs actually fire for the approved ones.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { createDb, schema, type Db } from "@medianexus/database";
import type { Release } from "@medianexus/domain";
import { SeriesController } from "../src/series/series.controller";
import { SeriesService } from "../src/series/series.service";
import { LibraryScanService } from "../src/library-scan/library-scan.service";
import { GlobalExceptionFilter } from "../src/common/errors.filter";
import type { IndexersService } from "../src/indexers/indexers.service";
import type { EventsService } from "../src/events/events.service";
import type { AutoTagsService } from "../src/auto-tags/auto-tags.service";
import type { ConfigService } from "../src/system/config.service";

const dir = mkdtempSync(join(tmpdir(), "mn-season-autosearch-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });

let counter = 0;
function freshDb(): Db {
  const handle = createDb(join(dir, `sas-${counter++}.db`));
  handle.runMigrations();
  handles.push(handle);
  return handle.db;
}

/** A search result entry carrying the decision the picker consumes (approved). */
function hit(title: string): Release & {
  decision: { release: Release; approved: true; rejections: never[]; profile: null; formatScore: number };
} {
  const r: Release = {
    id: title, indexerId: "idx1", indexerName: "Demo", title, protocol: "usenet",
    categories: [], size: 1000, ageHours: 1, seeders: 5, leechers: 0,
    quality: { source: "web", resolution: "1080p", edition: "" },
    isFreeleech: false, isProper: false, isRepack: false,
  };
  return { ...r, decision: { release: r, approved: true as const, rejections: [], profile: null, formatScore: 0 } };
}

async function seed(db: Db) {
  const now = new Date().toISOString();
  await db.insert(schema.series).values({
    id: "s1", tvdbId: 121361, tmdbId: 1399, imdbId: "tt0000001", title: "Test Show",
    overview: "", status: "released", seriesType: "standard", network: null, firstAirYear: 2020,
    monitored: true, certification: null, runtime: null, trailerId: null, tmdbRating: null,
    qualityProfileId: null, rootFolderPath: "", genres: [], images: [], tags: [],
    addedAt: now, updatedAt: now,
  }).run();
  await db.insert(schema.season).values({ id: "sea1", seriesId: "s1", seasonNumber: 1, monitored: true }).run();
  await db.insert(schema.season).values({ id: "sea2", seriesId: "s1", seasonNumber: 2, monitored: true }).run();
  const ep = (id: string, seasonId: string, n: number, hasFile: boolean) =>
    db.insert(schema.episode).values({ id, seriesId: "s1", seasonId, episodeNumber: n, title: `Ep ${n}`, overview: "", airDateUtc: null, monitored: true, hasFile }).run();
  await ep("ep1", "sea1", 1, false);
  await ep("ep2", "sea1", 2, false);
  await ep("ep3", "sea1", 3, false);
  await ep("ep4", "sea1", 4, true); // already has a file -> must be skipped
  await ep("ep5", "sea2", 1, false); // different season -> must be left alone
}

function buildApp(db: Db) {
  const grabbed: string[] = [];
  const indexers = {
    // Key off the SxxExx in the per-episode query to control outcomes deterministically.
    search: async ({ query }: { query?: string }) => {
      const m = /S\d+E(\d+)/i.exec(query ?? "");
      const n = m ? Number(m[1]) : 0;
      if (n === 1) return { releases: [hit("Test.Show.S01E01.1080p.WEB-DL")] };
      if (n === 2) return { releases: [hit("Test.Show.S01E02.1080p.WEB-DL")] };
      return { releases: [] }; // episode 3 (and any other) -> no acceptable release
    },
    grab: async ({ release }: { release: Release }) => { grabbed.push(release.title); },
  } as unknown as IndexersService;

  const service = new SeriesService(
    db,
    { publish: () => undefined } as unknown as EventsService,
    { appliedTags: async () => [] } as unknown as AutoTagsService,
    { get: async () => ({}) } as unknown as ConfigService,
    indexers,
  );

  return { service, grabbed: () => grabbed };
}

interface SeasonAutoResult {
  attempted: number;
  grabbed: number;
  results: { episodeId: string; grabbed: boolean; release?: Release }[];
}

describe("DETAILPAGE-FE2 — season-level auto-search over the real controller/service", () => {
  let app: INestApplication;
  let grabbed: () => string[];

  beforeAll(async () => {
    const db = freshDb();
    await seed(db);
    const built = buildApp(db);
    grabbed = built.grabbed;
    const moduleRef = await Test.createTestingModule({
      controllers: [SeriesController],
      providers: [
        { provide: SeriesService, useValue: built.service },
        // SeriesController gained a LibraryScanService dependency for the manage-files
        // endpoints (FILEMGMT-2); this spec only drives auto-search, so a stub suffices.
        { provide: LibraryScanService, useValue: {} as unknown as LibraryScanService },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
  });

  afterAll(async () => { await app?.close(); });

  it("searches every missing episode of the season, skips hasFile ones, and reports per-episode results", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/v1/series/s1/seasons/1/auto-search")
      .set("X-Api-Key", "test-key");
    expect(res.status).toBe(201);
    const body = res.body as SeasonAutoResult;
    expect(body.attempted).toBe(3);
    expect(body.grabbed).toBe(2);
    // Results cover only the attempted (missing) episodes, in episode order.
    expect(body.results.map((r) => r.episodeId)).toEqual(["ep1", "ep2", "ep3"]);
    const byId = new Map(body.results.map((r) => [r.episodeId, r]));
    expect(byId.get("ep1")!.grabbed).toBe(true);
    expect(byId.get("ep2")!.grabbed).toBe(true);
    expect(byId.get("ep3")!.grabbed).toBe(false); // no acceptable release
    expect(byId.get("ep3")!.release).toBeUndefined();
    // Episode 4 (has file) and the other season's episode were never attempted or grabbed.
    expect(byId.has("ep4")).toBe(false);
    expect(byId.has("ep5")).toBe(false);
    expect(grabbed()).toEqual(["Test.Show.S01E01.1080p.WEB-DL", "Test.Show.S01E02.1080p.WEB-DL"]);
  });

  it("returns 404 for an unknown series", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/v1/series/nope/seasons/1/auto-search")
      .set("X-Api-Key", "test-key");
    expect(res.status).toBe(404);
  });
});
