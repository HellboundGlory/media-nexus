// SPDX-License-Identifier: MIT
/**
 * UNI-020 — bulk actions on Movies/Series lists. These fan out over the existing single-item
 * update()/remove() methods, so the coverage targets the seams that matter:
 *   - bulk-edit applies only the fields present in the patch (the "No Change" omission rule) to
 *     every selected id, and a single bad id doesn't fail the whole batch (per-id aggregation);
 *   - bulk-tags add/remove/replace are real set operations (not a trivial pass-through);
 *   - bulk-delete forwards the opt-in deleteFiles/addImportExclusion per item.
 * Uses a real temp SQLite DB (repo convention) plus a real temp directory for the deleteFiles disk
 * assertion. One network-level test (full AppModule) proves the route + zod pipe genuinely omit
 * the untouched fields.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import request from "supertest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { createDb, schema } from "@medianexus/database";
import { EventBus } from "@medianexus/events";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/configure";
import { ConfigService } from "../src/system/config.service";
import { EventsService } from "../src/events/events.service";
import { AutoTagsService } from "../src/auto-tags/auto-tags.service";
import { MoviesService } from "../src/movies/movies.service";
import { SeriesService } from "../src/series/series.service";

const dir = mkdtempSync(join(tmpdir(), "mn-bulk-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });

async function makeServices() {
  const handle = createDb(join(dir, `bulk-${handles.length}.db`));
  handle.runMigrations();
  handles.push(handle);
  const config = new ConfigService(handle.db);
  const events = new EventsService(new EventBus());
  const autoTags = new AutoTagsService(handle.db);
  const movies = new MoviesService(handle.db, events, autoTags, config);
  const series = new SeriesService(handle.db, events, autoTags, config);
  return { db: handle.db, movies, series };
}

async function seedMovie(db: Awaited<ReturnType<typeof makeServices>>["db"], id: string, over: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return db.insert(schema.movie).values({
    id, tmdbId: Number(id.replace(/\D/g, "")) || 1000, title: `Movie ${id}`, overview: "", status: "released",
    releaseDate: "2020-01-01", monitored: true, qualityProfileId: null, rootFolderPath: "", folderName: null,
    minimumAvailability: "released", genres: [], images: [], tags: [], hasFile: false, addedAt: now, updatedAt: now,
    ...over,
  }).run();
}

async function seedSeries(db: Awaited<ReturnType<typeof makeServices>>["db"], id: string, over: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return db.insert(schema.series).values({
    id, tvdbId: Number(id.replace(/\D/g, "")) || 1, tmdbId: null, imdbId: null, title: `Show ${id}`, overview: "", status: "unknown", seriesType: "standard",
    network: null, firstAirYear: 2020, monitored: true, qualityProfileId: null, rootFolderPath: "", folderName: null,
    genres: [], images: [], tags: [], alternateTitles: [], addedAt: now, updatedAt: now, ...over,
  }).run();
}

async function movieTags(db: Awaited<ReturnType<typeof makeServices>>["db"], id: string): Promise<string[]> {
  const row = await db.select({ tags: schema.movie.tags }).from(schema.movie).where(eq(schema.movie.id, id)).limit(1);
  return row[0]?.tags ?? [];
}
async function seriesTags(db: Awaited<ReturnType<typeof makeServices>>["db"], id: string): Promise<string[]> {
  const row = await db.select({ tags: schema.series.tags }).from(schema.series).where(eq(schema.series.id, id)).limit(1);
  return row[0]?.tags ?? [];
}

describe("MoviesService.bulkEdit (UNI-020)", () => {
  it("applies the provided fields to every selected movie and leaves omitted fields untouched", async () => {
    const { db, movies } = await makeServices();
    await seedMovie(db, "m1", { title: "Alpha", monitored: true });
    await seedMovie(db, "m2", { title: "Beta", monitored: true, rootFolderPath: "/data/beta" });

    const res = await movies.bulkEdit(["m1", "m2"], { monitored: false });
    expect(res.updated.sort()).toEqual(["m1", "m2"]);
    expect(res.failed).toEqual([]);

    const rows = await db.select().from(schema.movie).where(eq(schema.movie.monitored, false));
    expect(rows.map((r) => r.id).sort()).toEqual(["m1", "m2"]);
    // "No Change" fields (title, rootFolderPath) are NOT touched by a monitored-only patch.
    expect(rows.find((r) => r.id === "m1")?.title).toBe("Alpha");
    expect(rows.find((r) => r.id === "m2")?.rootFolderPath).toBe("/data/beta");
  });

  it("reports a per-id failure for a bad id instead of failing the whole batch", async () => {
    const { db, movies } = await makeServices();
    await seedMovie(db, "m1", { monitored: false });
    const res = await movies.bulkEdit(["m1", "nonexistent"], { monitored: true });
    expect(res.updated).toEqual(["m1"]);
    expect(res.failed.map((f) => f.id)).toEqual(["nonexistent"]);
    // The good one was applied even though the batch contained a bad id.
    const row = await db.select({ monitored: schema.movie.monitored }).from(schema.movie).where(eq(schema.movie.id, "m1")).limit(1);
    expect(row[0]?.monitored).toBe(true);
  });
});

describe("MoviesService.bulkTags (UNI-020)", () => {
  it("performs add / remove / replace as real set operations", async () => {
    const { db, movies } = await makeServices();
    await seedMovie(db, "t1", { tags: [] });
    await seedMovie(db, "t2", { tags: ["a"] });
    await seedMovie(db, "t3", { tags: ["a", "b"] });

    // add = union (dedupes, keeps existing)
    await movies.bulkTags(["t1", "t2"], ["a", "b"], "add");
    expect(await movieTags(db, "t1")).toEqual(["a", "b"]);
    expect(await movieTags(db, "t2")).toEqual(["a", "b"]);

    // remove = set-difference
    await movies.bulkTags(["t2", "t3"], ["a"], "remove");
    expect(await movieTags(db, "t2")).toEqual(["b"]);
    expect(await movieTags(db, "t3")).toEqual(["b"]);

    // replace = overwrite; empty tagIds clears
    await movies.bulkTags(["t1"], ["z"], "replace");
    expect(await movieTags(db, "t1")).toEqual(["z"]);
    await movies.bulkTags(["t1"], [], "replace");
    expect(await movieTags(db, "t1")).toEqual([]);
  });
});

describe("MoviesService.bulkDelete (UNI-020)", () => {
  it("removes all selected movies, forwards addImportExclusion per item, and aggregates a bad id", async () => {
    const { db, movies } = await makeServices();
    await seedMovie(db, "d1", { tmdbId: 700 });
    await seedMovie(db, "d2", { tmdbId: 701 });

    const res = await movies.bulkDelete(["d1", "d2", "nope"], { addImportExclusion: true });
    expect(res.updated.sort()).toEqual(["d1", "d2"]);
    expect(res.failed.map((f) => f.id)).toEqual(["nope"]);

    const remaining = await db.select({ id: schema.movie.id }).from(schema.movie).all();
    expect(remaining).toHaveLength(0);
    const excl = await db.select({ externalId: schema.importExclusion.externalId }).from(schema.importExclusion).all();
    expect(excl.map((e) => e.externalId).sort()).toEqual(["700", "701"]);
  });

  it("forwards deleteFiles per item (disposes the on-disk folder)", async () => {
    const delDir = mkdtempSync(join(tmpdir(), "mn-bulk-del-"));
    const folderPath = join(delDir, "bulkdel");
    mkdirSync(folderPath);
    expect(existsSync(folderPath)).toBe(true);

    const { db, movies } = await makeServices();
    await seedMovie(db, "x1", { rootFolderPath: delDir, folderName: "bulkdel" });
    const res = await movies.bulkDelete(["x1"], { deleteFiles: true });
    expect(res.updated).toEqual(["x1"]);
    // deleteFiles was forwarded to remove() -> the folder was disposed from disk.
    expect(existsSync(folderPath)).toBe(false);
  });
});

describe("SeriesService bulk methods (UNI-020)", () => {
  it("bulk-edit applies seriesType to every selected series; bulk-tags set-ops; bulk-delete removes", async () => {
    const { db, series } = await makeServices();
    await seedSeries(db, "s1", { seriesType: "standard", tags: [] });
    await seedSeries(db, "s2", { seriesType: "standard", tags: ["a"] });

    const edit = await series.bulkEdit(["s1", "s2"], { seriesType: "anime" });
    expect(edit.updated.sort()).toEqual(["s1", "s2"]);
    const rows = await db.select({ id: schema.series.id, seriesType: schema.series.seriesType }).from(schema.series).all();
    expect(rows.every((r) => r.seriesType === "anime")).toBe(true);

    await series.bulkTags(["s2"], ["b"], "add");
    expect(await seriesTags(db, "s2")).toEqual(["a", "b"]);
    await series.bulkTags(["s2"], [], "replace");
    expect(await seriesTags(db, "s2")).toEqual([]);

    const del = await series.bulkDelete(["s1", "s2"], {});
    expect(del.updated.sort()).toEqual(["s1", "s2"]);
    const remaining = await db.select({ id: schema.series.id }).from(schema.series).all();
    expect(remaining).toHaveLength(0);
  });
});

describe("POST /movies/bulk-edit (endpoint, No-Change omission)", () => {
  let app: INestApplication;
  let http: any;
  const API_KEY = "test-bootstrap-key-123";

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "mn-bulk-app-"));
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = join(dir, "test.db");
    process.env.AUTO_MIGRATE = "true";
    process.env.MEDIA_NEXUS_SECRET = "test-secret-only";
    process.env.MEDIA_NEXUS_BOOTSTRAP_KEY = API_KEY;
    process.env.JOB_CONCURRENCY = "1";
    process.env.LOG_LEVEL = "warn";
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    http = app.getHttpServer();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("applies only the fields present in the body — untouched fields stay 'No Change'", async () => {
    const movies = app.get(MoviesService);
    const m1 = await movies.create({ title: "Bulk One", tmdbId: 5001, overview: "", monitored: true, rootFolderPath: "/data/a", minimumAvailability: "released", tags: [] });
    const m2 = await movies.create({ title: "Bulk Two", tmdbId: 5002, overview: "", monitored: true, rootFolderPath: "/data/b", minimumAvailability: "released", tags: [] });

    // Body carries rootFolderPath only — monitored/minimumAvailability/title must be omitted.
    const res = await request(http)
      .post("/api/v1/movies/bulk-edit")
      .set("X-Api-Key", API_KEY)
      .send({ ids: [m1.id, m2.id], rootFolderPath: "/data/new" });
    expect(res.status).toBe(201);
    expect(res.body.updated.sort()).toEqual([m1.id, m2.id].sort());
    expect(res.body.failed).toEqual([]);

    for (const id of [m1.id, m2.id]) {
      const got = await movies.get(id);
      expect(got.rootFolderPath).toBe("/data/new"); // applied
      expect(got.title).toBe(id === m1.id ? "Bulk One" : "Bulk Two"); // untouched — No Change omission
      expect(got.monitored).toBe(true); // untouched
      expect(got.minimumAvailability).toBe("released"); // untouched
    }
  });
});
