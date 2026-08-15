// SPDX-License-Identifier: MIT
/**
 * Gap report I6 — a manual grab re-searched all indexers twice.
 *
 * The URL-decoded-bug-fix: the frontend already has the full `Release` in hand from the
 * interactive `/search`, but `grabRequestSchema` had no `release` field, so
 * `ZodValidationPipe` stripped it before `IndexersService.grab()` ever saw it — and grab()
 * then re-searched every configured indexer (up to 2 provider.search() calls each) to
 * re-resolve the release id, doubling the indexer load + rate-limit spend on every manual grab.
 *
 * Now that `grabRequestSchema` accepts an optional `release` (validated against the same
 * `releaseSchema`), forwarding it skips the re-search. This spec tests through the ACTUAL
 * `IndexersController` + DTO layer (supertest over a Nest module with the real
 * `IndexersService` and a spied provider), because calling `IndexersService.grab()`
 * directly would bypass the DTO that was the actual bug.
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
import { IndexersController } from "../src/indexers/indexers.controller";
import { IndexersService } from "../src/indexers/indexers.service";
import { RateLimitGuard } from "../src/common/rate-limit.guard";
import { GlobalExceptionFilter } from "../src/common/errors.filter";
import type { ProvidersService } from "../src/providers/demo.providers";
import type { DecisionService } from "../src/decision/decision.service";
import type { EventsService } from "../src/events/events.service";
import type { ProviderStatusService } from "../src/providers/provider-status.service";
import type { ConfigService } from "../src/system/config.service";
import type { IndexerContract } from "@medianexus/integrations";

const dir = mkdtempSync(join(tmpdir(), "mn-grabrelease-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });

let counter = 0;
function freshDb(): Db {
  const handle = createDb(join(dir, `gr-${counter++}.db`));
  handle.runMigrations();
  handles.push(handle);
  return handle.db;
}

function release(over: Partial<Release> = {}): Release {
  return {
    id: "r1", indexerId: "idx1", indexerName: "Demo", title: "Good.Movie.2024.1080p.WEB-DL",
    protocol: "torrent", categories: [], size: 1000, ageHours: 1, seeders: 10, leechers: 1,
    quality: { source: "web", resolution: "1080p", edition: "" },
    isFreeleech: false, isProper: false, isRepack: false,
    ...over,
  };
}

/**
 * Build a Nest module with the real controller + real IndexersService, but with a spied
 * provider wired in, so a POST /api/v1/grabs runs the full DTO validation AND the real
 * grab() path; we assert on how many times the provider's search was hit.
 */
async function buildApp(opts: {
  db: Db;
  decide?: (r: Release) => { approved: boolean; rejections?: { reason: string; message: string }[] };
  releaseFromSearch?: Release;
}) {
  const db = opts.db;
  // grab() writes a queue entry referencing a download client — a real row must exist (FK).
  const now = new Date().toISOString();
  await db.insert(schema.downloadClient).values({
    id: "dc1", name: "qbt", implementation: "qbittorrent", kind: "torrent", enabled: true,
    priority: 1, settings: { host: "http://h" }, tags: [], createdAt: now, updatedAt: now,
  }).run();

  let searchCalls = 0;
  const provider = {
    search: async () => { searchCalls++; return opts.releaseFromSearch ? [opts.releaseFromSearch] : []; },
  } as unknown as IndexerContract;

  const providers = {
    configuredIndexers: async () => [{ row: { id: "idx1" }, provider }],
    pickDownloadClient: async () => ({
      row: { id: "dc1", name: "qbt", implementation: "qbittorrent" },
      provider: { addRelease: async () => ({ downloadId: "d1" }) },
    }),
  } as unknown as ProvidersService;

  const decisions = {
    evaluate: async (_mt: string, _mid: string, r: Release) => {
      if (opts.decide) return opts.decide(r);
      return { release: r, approved: true, profile: null, formatScore: 0, rejections: [] };
    },
  } as unknown as DecisionService;

  const events = { publish: () => undefined } as unknown as EventsService;
  const config = { get: async () => ({ "paths.downloads": "" }) } as unknown as ConfigService;
  const status = {
    beforeCall: async () => ({ skip: false }),
    recordSuccess: () => undefined,
    recordFailure: () => undefined,
  } as unknown as ProviderStatusService;

  const indexers = new IndexersService(db, providers, events, config, decisions, status);

  const moduleRef = await Test.createTestingModule({
    controllers: [IndexersController],
    providers: [RateLimitGuard, { provide: IndexersService, useValue: indexers }],
  }).compile();

  const app: INestApplication = moduleRef.createNestApplication();
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
  return { app, searchCalls: () => searchCalls };
}

describe("I6 — manual grab does not double indexer search (controller/DTO layer)", () => {
  let app: INestApplication;
  let searchCalls: () => number;

  beforeAll(async () => {
    const db = freshDb();
    const now = new Date().toISOString();
    await db.insert(schema.movie).values({
      id: "m1", tmdbId: 1, title: "Good Movie", overview: "", status: "released",
      releaseDate: "2024-01-01", monitored: true, qualityProfileId: null,
      rootFolderPath: "", minimumAvailability: "announced", genres: [], images: [], tags: [],
      hasFile: false, addedAt: now, updatedAt: now,
    });
    const built = await buildApp({ db, releaseFromSearch: release() });
    app = built.app;
    searchCalls = built.searchCalls;
  });

  afterAll(async () => { await app?.close(); });

  it("accepts an optional release in the grab DTO and skips the re-search round-trip", async () => {
    const before = searchCalls();
    const res = await request(app.getHttpServer())
      .post("/api/v1/grabs")
      .set("X-Api-Key", "test-key")
      .send({
        mediaType: "movie", mediaId: "m1", releaseId: "r1", indexerId: "idx1",
        release: release(),
      });
    expect(res.status).toBe(201);
    // Zero provider.search() calls — the manual grab used the caller-supplied release,
    // not a hidden second round-trip.
    expect(searchCalls() - before).toBe(0);
  });

  it("still resolves + grabs via re-search when the caller omits release (backward compatible)", async () => {
    // New app with a provider that returns the release from search so the fallback resolves it.
    const db = freshDb();
    const now = new Date().toISOString();
    await db.insert(schema.movie).values({
      id: "m2", tmdbId: 2, title: "Other Movie", overview: "", status: "released",
      releaseDate: "2024-01-01", monitored: true, qualityProfileId: null,
      rootFolderPath: "", minimumAvailability: "announced", genres: [], images: [], tags: [],
      hasFile: false, addedAt: now, updatedAt: now,
    });
    const built = await buildApp({ db, releaseFromSearch: release({ id: "r2", title: "Other.Movie.2024.1080p.WEB-DL" }) });
    const app2 = built.app;
    try {
      const before = built.searchCalls();
      const res = await request(app2.getHttpServer())
        .post("/api/v1/grabs")
        .set("X-Api-Key", "test-key")
        .send({ mediaType: "movie", mediaId: "m2", releaseId: "r2" });
      expect(res.status).toBe(201);
      // The re-search fallback fired (caller omitted release) — still works.
      expect(built.searchCalls() - before).toBeGreaterThan(0);
    } finally { await app2.close(); }
  });

  it("still re-evaluates the decision when release is caller-supplied (rejected -> no grab)", async () => {
    const db = freshDb();
    const now = new Date().toISOString();
    await db.insert(schema.movie).values({
      id: "m3", tmdbId: 3, title: "Blocked Movie", overview: "", status: "released",
      releaseDate: "2024-01-01", monitored: true, qualityProfileId: null,
      rootFolderPath: "", minimumAvailability: "announced", genres: [], images: [], tags: [],
      hasFile: false, addedAt: now, updatedAt: now,
    });
    const built = await buildApp({
      db,
      releaseFromSearch: release(),
      decide: () => ({ approved: false, rejections: [{ reason: "blocklisted", message: "blocklisted" }] }),
    });
    const app3 = built.app;
    try {
      const res = await request(app3.getHttpServer())
        .post("/api/v1/grabs")
        .set("X-Api-Key", "test-key")
        .send({ mediaType: "movie", mediaId: "m3", releaseId: "r1", indexerId: "idx1", release: release() });
      // Approved=false -> ApiError CONFLICT -> 409. Decision gate still fires even though
      // release was caller-supplied.
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("CONFLICT");
      // And because it's decided before the grab, nothing was added to the download client —
      // verify no queue entry was written.
      const q = await db.select().from(schema.downloadQueueEntry).all();
      expect(q.length).toBe(0);
    } finally { await app3.close(); }
  });
});
