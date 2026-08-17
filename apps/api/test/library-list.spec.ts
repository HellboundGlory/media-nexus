// SPDX-License-Identifier: MIT
/**
 * UNI-029 (pass 1) — server-side Sort + Filter on the Movies/Series list endpoints.
 *
 * Service-level (real DB): sort ordering is applied server-side for at least title and year
 * (the two with real cross-service column differences), and the movies "missing" filter reduces
 * to monitored AND fileless.
 * Endpoint-level (full AppModule, supertest): an invalid sort/filter query param returns a clean
 * 400 (not silently ignored or a crash), and the movies-only "missing" filter is rejected on the
 * series endpoint.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const dir = mkdtempSync(join(tmpdir(), "mn-list-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });

async function makeServices() {
  const handle = createDb(join(dir, `list-${handles.length}.db`));
  handle.runMigrations();
  handles.push(handle);
  const config = new ConfigService(handle.db);
  const events = new EventsService(new EventBus());
  const autoTags = new AutoTagsService(handle.db);
  return { db: handle.db, movies: new MoviesService(handle.db, events, autoTags, config), series: new SeriesService(handle.db, events, autoTags, config) };
}

let movieTmdb = 900000;
let seriesTvdb = 9000;

async function seedMovie(db: Awaited<ReturnType<typeof makeServices>>["db"], id: string, over: Record<string, unknown> = {}) {
  return db.insert(schema.movie).values({
    id, tmdbId: ++movieTmdb, title: `Movie ${id}`, overview: "", status: "released",
    releaseDate: "2020-01-01", monitored: true, qualityProfileId: null, rootFolderPath: "", folderName: null,
    minimumAvailability: "released", genres: [], images: [], tags: [], hasFile: false, addedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...over,
  }).run();
}

async function seedSeries(db: Awaited<ReturnType<typeof makeServices>>["db"], id: string, over: Record<string, unknown> = {}) {
  return db.insert(schema.series).values({
    id, tvdbId: ++seriesTvdb, tmdbId: null, imdbId: null, title: `Show ${id}`, overview: "", status: "unknown", seriesType: "standard",
    network: null, firstAirYear: 2020, monitored: true, qualityProfileId: null, rootFolderPath: "", folderName: null,
    genres: [], images: [], tags: [], alternateTitles: [], addedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...over,
  }).run();
}

describe("MoviesService/SeriesService list — server-side sort + filter (UNI-029)", () => {
  it("sorts movies server-side on title (asc) and year/date (desc)", async () => {
    const { db, movies } = await makeServices();
    // Insert out of sorted order so default addedAt order differs from title/year order.
    await seedMovie(db, "a", { title: "Charlie", releaseDate: "1990-01-01" });
    await seedMovie(db, "b", { title: "Alpha", releaseDate: "2010-01-01" });
    await seedMovie(db, "c", { title: "Bravo", releaseDate: "2000-01-01" });

    const byTitle = await movies.list({ sort: "title", sortDir: "asc", pageSize: 50 });
    expect(byTitle.items.map((m) => m.title)).toEqual(["Alpha", "Bravo", "Charlie"]);

    const byYear = await movies.list({ sort: "year", sortDir: "desc", pageSize: 50 });
    expect(byYear.items.map((m) => m.title)).toEqual(["Alpha", "Bravo", "Charlie"]); // 2010, 2000, 1990
  });

  it("movies filter=missing reduces to monitored AND fileless", async () => {
    const { db, movies } = await makeServices();
    await seedMovie(db, "m1", { monitored: true, hasFile: false });  // missing
    await seedMovie(db, "m2", { monitored: true, hasFile: true });   // have
    await seedMovie(db, "m3", { monitored: false, hasFile: false }); // unmonitored, fileless

    const missing = await movies.list({ filter: "missing", pageSize: 50 });
    expect(missing.items.map((m) => m.id)).toEqual(["m1"]);
  });

  it("series sorts server-side and filters on monitored, but has no missing branch applied", async () => {
    const { db, series } = await makeServices();
    await seedSeries(db, "s1", { title: "Zulu", monitored: true });
    await seedSeries(db, "s2", { title: "Alpha Show", monitored: false });

    const byTitle = await series.list({ sort: "title", sortDir: "asc", pageSize: 50 });
    expect(byTitle.items.map((s) => s.title)).toEqual(["Alpha Show", "Zulu"]);

    const unmonitored = await series.list({ monitored: "false", pageSize: 50 });
    expect(unmonitored.items.map((s) => s.id)).toEqual(["s2"]);
  });
});

describe("GET /movies + /series list query validation (endpoint)", () => {
  let app: INestApplication;
  let http: any;
  const API_KEY = "test-bootstrap-key-123";

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "mn-list-app-"));
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

  const auth = (r: request.Test) => r.set("X-Api-Key", API_KEY);

  it("rejects an invalid sort and an invalid filter with a clean 400", async () => {
    expect((await auth(request(http).get("/api/v1/movies?sort=bogus"))).status).toBe(400);
    expect((await auth(request(http).get("/api/v1/movies?filter=whatever"))).status).toBe(400);
    expect((await auth(request(http).get("/api/v1/series?sort=bogus"))).status).toBe(400);
  });

  it("rejects the movies-only 'missing' filter on the series endpoint", async () => {
    expect((await auth(request(http).get("/api/v1/series?filter=missing"))).status).toBe(400);
  });

  it("accepts valid sort/sortDir/filter combinations on both endpoints", async () => {
    expect((await auth(request(http).get("/api/v1/movies?sort=title&sortDir=asc&filter=missing"))).status).toBe(200);
    expect((await auth(request(http).get("/api/v1/movies?sort=year&sortDir=desc"))).status).toBe(200);
    expect((await auth(request(http).get("/api/v1/series?sort=title&sortDir=asc&monitored=true"))).status).toBe(200);
  });
});
