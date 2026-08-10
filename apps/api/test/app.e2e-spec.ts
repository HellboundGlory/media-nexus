// SPDX-License-Identifier: MIT
/**
 * End-to-end/integration tests against the full NestJS app on a temp SQLite DB.
 * Covers: auth, media, requests->event->job, demo search/grab/import, jobs,
 * compat surface, AND the M1 real-pipeline (mock Newznab + SABnzbd over HTTP +
 * real filesystem import).
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
const auth = (r: any) => r.set("X-Api-Key", API_KEY);

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
  memClient = app.get<MemoryDownloadClientProvider>(MEMORY_DOWNLOAD_CLIENT);
});

afterAll(async () => {
  await app?.close();
});

describe("MediaNexus API (e2e)", () => {
  // ---- health & auth ----
  it("health endpoints are public and report ok", async () => {
    expect((await request(http).get("/health/live")).status).toBe(200);
    expect((await request(http).get("/health/ready")).status).toBe(200);
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
    expect((await auth(request(http).get("/api/v1/system/config"))).body["ui.theme"]).toBe("light");
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

    expect((await auth(request(http).get("/api/v1/movies"))).body.total).toBeGreaterThanOrEqual(1);
    expect((await auth(request(http).get(`/api/v1/movies/${id}`))).body.title).toBe("The Matrix");

    const del = await auth(request(http).delete(`/api/v1/movies/${id}`));
    expect(del.status).toBe(200);
  });

  // ---- series ----
  it("creates a series with default seasons", async () => {
    const created = await auth(request(http).post("/api/v1/series").send({ title: "Breaking Bad", tvdbId: 81189, firstAirYear: 2008 }));
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

    let found = false;
    for (let i = 0; i < 20 && !found; i++) {
      const runs = await auth(request(http).get("/api/v1/system/jobs/runs"));
      found = runs.body.some((r: any) => r.jobKey === "media.searchForRequest");
      if (!found) await new Promise((r) => setTimeout(r, 150));
    }
    expect(found).toBe(true);
  });

  // ---- demo pipeline: search -> grab -> download monitor -> import ----
  it("searches, grabs, downloads and imports a movie end-to-end (demo provider)", async () => {
    const movie = await auth(request(http).post("/api/v1/movies").send({ title: "The Matrix 4K", tmdbId: 6034 }));
    const mid = movie.body.id;

    const defs = await auth(request(http).get("/api/v1/indexers/definitions"));
    expect(defs.status).toBe(200);

    const idx = await auth(request(http).post("/api/v1/indexers").send({
      definitionKey: "memory", name: "Demo Search", protocol: "torrent", settings: { title: "Demo" },
    }));
    expect(idx.status).toBe(201);

    const search = await auth(request(http).post("/api/v1/search").send({ mediaType: "movie", mediaId: mid, query: "matrix" }));
    expect(search.status).toBe(201);
    expect(search.body.releases.length).toBeGreaterThan(0);

    const grab = await auth(request(http).post("/api/v1/grabs").send({
      mediaType: "movie", mediaId: mid, releaseId: search.body.releases[0].id,
    }));
    expect(grab.status).toBe(201);
    const downloadId = grab.body.downloadId;

    const queue = await auth(request(http).get("/api/v1/queue"));
    expect(queue.body.items.some((i: any) => i.downloadId === downloadId)).toBe(true);

    // simulate completion in the memory client + run the monitor job -> real file import
    memClient.completeDownload(downloadId, 100);
    const trig = await auth(request(http).post("/api/v1/system/commands/acquisition.downloadMonitor"));
    expect(trig.status).toBe(201);

    let imported = false;
    for (let i = 0; i < 20 && !imported; i++) {
      imported = (await auth(request(http).get(`/api/v1/movies/${mid}`))).body.hasFile === true;
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
    expect((await request(http).get("/api/sonarr/v3/series")).status).toBe(501);
  });
});

describe("M1: real indexer + download client end-to-end (mock HTTP + real filesystem)", () => {
  let newznabUrl: string;
  let sabUrl: string;
  let mediaRoot: string;
  const servers: import("node:http").Server[] = [];

  beforeAll(async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { createServer } = await import("node:http");
    const { join: j } = await import("node:path");
    const { tmpdir: osTmp } = await import("node:os");
    const base = mkdtempSync(j(osTmp(), "mn-m1-"));
    const downloadsRoot = j(base, "downloads");
    mediaRoot = j(base, "library");
    mkdirSync(downloadsRoot, { recursive: true });
    mkdirSync(mediaRoot, { recursive: true });

    const nz = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        channel: { title: "mock", item: [{
          title: "Blade.Runner.2049.2017.2160p.WEB.x265-GROUP",
          guid: "nz1",
          link: "https://mock/getnzb/1.nzb",
          "newznab:attr": [{ name: "size", value: "9000000000" }, { name: "seeders", value: "5" }],
        }] },
      }));
    });

    const sab = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const u = new URL(_req.url ?? "/", "http://x");
      const mode = u.searchParams.get("mode");
      if (mode === "addurl") res.end(JSON.stringify({ status: true, nzo_ids: ["NZO-M1"] }));
      else if (mode === "queue") res.end(JSON.stringify({ queue: { slots: [] } }));
      else if (mode === "history") res.end(JSON.stringify({ history: { slots: [{ nzo_id: "NZO-M1", filename: "Blade.Runner.2049.2017.2160p.WEB.x265-GROUP", status: "Completed" }] } }));
      else res.end(JSON.stringify({ status: false }));
    });

    await new Promise<void>((r) => nz.listen(0, "127.0.0.1", () => r()));
    await new Promise<void>((r) => sab.listen(0, "127.0.0.1", () => r()));
    servers.push(nz, sab);
    newznabUrl = `http://127.0.0.1:${(nz.address() as any).port}`;
    sabUrl = `http://127.0.0.1:${(sab.address() as any).port}`;

    // create a "downloaded" file the importer will find under downloadsRoot/complete/<title>
    const title = "Blade.Runner.2049.2017.2160p.WEB.x265-GROUP";
    const dir = j(downloadsRoot, "complete", title);
    mkdirSync(dir, { recursive: true });
    writeFileSync(j(dir, `${title}.mkv`), Buffer.alloc(2048));

    // point global paths at the sandboxes
    const r = await auth(request(http).put("/api/v1/system/config").send({
      "paths.downloads": downloadsRoot,
      "paths.rootFolders": [{ path: mediaRoot }],
    }));
    expect(r.status).toBe(200);
  });

  afterAll(async () => {
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  });

  it("searches a real newznab indexer, grabs via SABnzbd, and imports into the library", async () => {
    const movie = await auth(request(http).post("/api/v1/movies").send({ title: "Blade Runner 2049", releaseDate: "2017-10-06" }));
    expect(movie.status).toBe(201);
    const mid = movie.body.id;

    const idx = await auth(request(http).post("/api/v1/indexers").send({
      definitionKey: "generic-newznab", name: "Mock NZB", protocol: "usenet",
      settings: { baseUrl: newznabUrl, apiKey: "mock-api-key", categories: [2000, 5000] },
    }));
    expect(idx.status).toBe(201);

    const dc = await auth(request(http).post("/api/v1/download-clients").send({
      name: "Mock SABnzbd", implementation: "sabnzbd", kind: "usenet", priority: 1,
      settings: { host: sabUrl, apiKey: "mock-key", category: "movies" },
    }));
    expect(dc.status).toBe(201);
    const dcId = dc.body.id;

    const dcOk = await auth(request(http).post(`/api/v1/download-clients/${dcId}/test`));
    expect(dcOk.status).toBe(201);
    expect(dcOk.body.ok).toBe(true);

    const search = await auth(request(http).post("/api/v1/search").send({ mediaType: "movie", mediaId: mid, query: "blade runner" }));
    expect(search.status).toBe(201);
    expect(search.body.releases.length).toBeGreaterThan(0);
    const rel = search.body.releases[0];
    expect(rel.quality.resolution).toBe("2160p");
    expect(rel.quality.source).toBe("web");
    expect(rel.indexerName).toBe("Mock NZB");

    const grab = await auth(request(http).post("/api/v1/grabs").send({
      mediaType: "movie", mediaId: mid, releaseId: rel.id, indexerId: rel.indexerId, downloadClientId: dcId,
    }));
    expect(grab.status).toBe(201);
    expect(grab.body.downloadId).toBe("NZO-M1");
    expect(grab.body.client).toBe("Mock SABnzbd");

    const queue = await auth(request(http).get("/api/v1/queue"));
    const entry = queue.body.items.find((i: any) => i.downloadId === "NZO-M1");
    expect(entry).toBeTruthy();
    expect(entry.downloadClientId).toBe(dcId);

    const trig = await auth(request(http).post("/api/v1/system/commands/acquisition.downloadMonitor"));
    expect(trig.status).toBe(201);

    let imported = false;
    for (let i = 0; i < 30 && !imported; i++) {
      imported = (await auth(request(http).get(`/api/v1/movies/${mid}`))).body.hasFile === true;
      if (!imported) await new Promise((r) => setTimeout(r, 150));
    }
    expect(imported).toBe(true);

    const { readdirSync, existsSync } = await import("node:fs");
    const { join: j } = await import("node:path");
    const top = readdirSync(mediaRoot);
    expect(top.length).toBeGreaterThan(0);
    expect(existsSync(j(mediaRoot, top[0]))).toBe(true);

    const history = await auth(request(http).get("/api/v1/history"));
    const actions = history.body.items.map((i: any) => i.action);
    expect(actions).toContain("grabbed");
    expect(actions).toContain("import_completed");

    const q2 = await auth(request(http).get("/api/v1/queue"));
    expect(q2.body.items.find((i: any) => i.downloadId === "NZO-M1")?.status).toBe("imported");
  });
});
