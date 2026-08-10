// SPDX-License-Identifier: MIT
/**
 * End-to-end/integration tests against the full NestJS app on a temp SQLite DB.
 * Covers the highest-risk scaffold workflows: auth, media, requests->event->job,
 * search->grab->import (demo providers), compat surface, and jobs.
 */
import { describe, beforeAll, afterAll, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/configure";
import { MEMORY_DOWNLOAD_CLIENT } from "../src/providers/demo.providers";
import type { MemoryDownloadClientProvider } from "@medianexus/integrations";

const API_KEY = "test-bootstrap-key-123";
let app: INestApplication;
let http: any;
let memClient: MemoryDownloadClientProvider;

describe("MediaNexus API (e2e)", () => {
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "mn-test-"));
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = join(dir, "test.db");
    process.env.AUTO_MIGRATE = "true";
    process.env.MEDIA_NEXUS_SECRET = "test-secret-only";
    process.env.MEDIA_NEXUS_BOOTSTRAP_KEY = API_KEY;
    process.env.MEDIA_NEXUS_BOOTSTRAP_ADMIN_PASSWORD = "test-password-123";
    process.env.JOB_CONCURRENCY = "1";
    process.env.LOG_LEVEL = "warn";

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    http = app.getHttpServer();
    memClient = app.get<MemoryDownloadClientProvider>(MEMORY_DOWNLOAD_CLIENT);  });

  afterAll(async () => {
    await app?.close();
  });

  const auth = (r: any) => r.set("X-Api-Key", API_KEY);

  // ---- health & auth ----
  it("health endpoints are public and report ok", async () => {
    const live = await request(http).get("/health/live");
    expect(live.status).toBe(200);
    const ready = await request(http).get("/health/ready");
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe("ok");
  });

  it("rejects API calls without/with invalid keys", async () => {
    expect((await request(http).get("/api/v1/movies")).status).toBe(401);
    expect((await request(http).get("/api/v1/movies").set("X-Api-Key", "wrong")).status).toBe(401);
  });

  it("whoami identifies the admin key", async () => {
    const res = await auth(request(http).get("/api/v1/auth/whoami"));
    expect(res.status).toBe(200);
    expect(res.body.principal.username).toBe("admin");
    expect(res.body.principal.isAdmin).toBe(true);
  });

  // ---- system ----
  it("exposes system status + settings round-trip", async () => {
    const status = await auth(request(http).get("/api/v1/system/status"));
    expect(status.status).toBe(200);
    expect(status.body.appName).toBe("media-nexus");

    const cfg = await auth(request(http).put("/api/v1/system/config").send({ "ui.theme": "light" }));
    expect(cfg.status).toBe(200);
    expect(cfg.body["ui.theme"]).toBe("light");

    const fetched = await auth(request(http).get("/api/v1/system/config"));
    expect(fetched.body["ui.theme"]).toBe("light");
  });

  // ---- movies ----
  it("creates, lists, dedupes and removes movies", async () => {
    const created = await auth(request(http).post("/api/v1/movies").send({
      title: "The Matrix", tmdbId: 603, overview: "A hacker discovers reality is a simulation.", releaseDate: "1999-03-31",
    }));
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect(id).toBeTruthy();

    const dup = await auth(request(http).post("/api/v1/movies").send({ title: "Matrix2", tmdbId: 603 }));
    expect(dup.status).toBe(409);

    const list = await auth(request(http).get("/api/v1/movies"));
    expect(list.body.total).toBeGreaterThanOrEqual(1);

    const got = await auth(request(http).get(`/api/v1/movies/${id}`));
    expect(got.body.title).toBe("The Matrix");

    // audited via domain event
    const audit = await auth(request(http).get("/api/v1/system/jobs/runs"));
    expect(audit.status).toBe(200);

    const del = await auth(request(http).delete(`/api/v1/movies/${id}`));
    expect(del.status).toBe(200);
  });

  // ---- series ----
  it("creates a series with default seasons", async () => {
    const created = await auth(request(http).post("/api/v1/series").send({
      title: "Breaking Bad", tvdbId: 81189, firstAirYear: 2008,
    }));
    expect(created.status).toBe(201);
    const id = created.body.id;
    const seasons = await auth(request(http).get(`/api/v1/series/${id}/seasons`));
    expect(seasons.status).toBe(200);
    expect(seasons.body.length).toBeGreaterThanOrEqual(2);
  });

  // ---- requests -> event -> job ----
  it("creates an approved request (admin) that fires the search job via event", async () => {
    const movie = await auth(request(http).post("/api/v1/movies").send({ title: "Inception", tmdbId: 27205 }));
    const reqRes = await auth(request(http).post("/api/v1/requests").send({ mediaType: "movie", mediaId: movie.body.id }));
    expect(reqRes.status).toBe(201);
    expect(reqRes.body.status).toBe("approved");

    // event->job: wait for media.searchForRequest run to appear
    let found = false;
    for (let i = 0; i < 20 && !found; i++) {
      const runs = await auth(request(http).get("/api/v1/system/jobs/runs"));
      found = runs.body.some((r: any) => r.jobKey === "media.searchForRequest");
      if (!found) await new Promise((r) => setTimeout(r, 150));
    }
    expect(found).toBe(true);
  });

  // ---- search -> grab -> download monitor -> import (demo providers) ----
  it("searches, grabs, downloads and imports a movie end-to-end", async () => {
    const movie = await auth(request(http).post("/api/v1/movies").send({ title: "The Matrix 4K", tmdbId: 6034 }));
    const mid = movie.body.id;

    // indexer definition catalog
    const defs = await auth(request(http).get("/api/v1/indexers/definitions"));
    expect(defs.status).toBe(200);

    // configure the demo indexer
    const idx = await auth(request(http).post("/api/v1/indexers").send({
      definitionKey: "memory", name: "Demo Search", protocol: "torrent", settings: { title: "Demo" },
    }));
    expect(idx.status).toBe(201);
    const indexerId = idx.body.id;

    const search = await auth(request(http).post("/api/v1/search").send({ mediaType: "movie", mediaId: mid, query: "matrix" }));
    expect(search.status).toBe(201);
    expect(search.body.releases.length).toBeGreaterThan(0);

    const grab = await auth(request(http).post("/api/v1/grabs").send({
      mediaType: "movie", mediaId: mid, releaseId: search.body.releases[0].id, indexerId,
    }));
    expect(grab.status).toBe(201);
    const downloadId = grab.body.downloadId;

    const queue = await auth(request(http).get("/api/v1/queue"));
    expect(queue.body.items.some((i: any) => i.downloadId === downloadId)).toBe(true);

    // simulate completion in the memory client, then run the monitor job
    memClient.completeDownload(downloadId, 100);
    const trig = await auth(request(http).post("/api/v1/system/commands/acquisition.downloadMonitor"));
    expect(trig.status).toBe(201);

    // wait for import; movie gets hasFile + history import_completed
    let imported = false;
    for (let i = 0; i < 20 && !imported; i++) {
      const got = await auth(request(http).get(`/api/v1/movies/${mid}`));
      imported = got.body.hasFile === true;
      if (!imported) await new Promise((r) => setTimeout(r, 150));
    }
    expect(imported).toBe(true);

    const hist = await auth(request(http).get("/api/v1/history"));
    const actions = hist.body.items.map((i: any) => i.action);
    expect(actions).toContain("grabbed");
    expect(actions).toContain("import_completed");
  });

  // ---- jobs ----
  it("runs a manual health check job to success", async () => {
    const run = await auth(request(http).post("/api/v1/system/commands/system.healthCheck"));
    expect(run.status).toBe(201);
    const runId = run.body.id;
    let status = "queued";
    for (let i = 0; i < 20 && status !== "succeeded"; i++) {
      const runs = await auth(request(http).get("/api/v1/system/jobs/runs"));
      const row = runs.body.find((r: any) => r.id === runId);
      if (row) status = row.status;
      if (status !== "succeeded") await new Promise((r) => setTimeout(r, 100));
    }
    expect(status).toBe("succeeded");
  });

  // ---- compatibility ----
  it("serves the sonarr v3 status read and 501s unimplemented compat routes", async () => {
    const ok = await request(http).get("/api/sonarr/v3/system/status");
    expect(ok.status).toBe(200);
    expect(ok.body.appName).toBe("MediaNexus");
    expect(ok.body.authentication).toBe("ApiKey");

    const notReady = await request(http).get("/api/sonarr/v3/series");
    expect(notReady.status).toBe(501);
  });
});
