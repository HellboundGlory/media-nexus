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
  it("serves the sonarr v3 status + series surface and 404s unknown compat routes", async () => {
    const ok = await request(http).get("/api/sonarr/v3/system/status");
    expect(ok.status).toBe(200);
    expect(ok.body.appName).toBe("MediaNexus");
    expect(ok.body.authentication).toBe("ApiKey");
    // read surface: empty list (array) not a 501
    const series = await request(http).get("/api/sonarr/v3/series");
    expect(series.status).toBe(200);
    expect(Array.isArray(series.body)).toBe(true);
    expect((await request(http).get("/api/sonarr/v3/not-a-route")).status).toBe(404);
  });
});

describe("M1: real indexer + download client end-to-end (mock HTTP + real filesystem)", () => {
  let newznabUrl: string;
  let sabUrl: string;
  let mediaRoot: string;
  let m1IdxId: string;
  let m1DcId: string;
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
    if (m1IdxId) await auth(request(http).delete(`/api/v1/indexers/${m1IdxId}`)).catch(() => {});
    if (m1DcId) await auth(request(http).delete(`/api/v1/download-clients/${m1DcId}`)).catch(() => {});
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
    m1IdxId = idx.body.id;

    const dc = await auth(request(http).post("/api/v1/download-clients").send({
      name: "Mock SABnzbd", implementation: "sabnzbd", kind: "usenet", priority: 1,
      settings: { host: sabUrl, apiKey: "mock-key", category: "movies" },
    }));
    expect(dc.status).toBe(201);
    const dcId = dc.body.id;
    m1DcId = dcId;

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


describe("M2: series auto-grab via RSS sync + episode import (mock HTTP + real filesystem)", () => {
  let newznabUrl: string;
  let sabUrl: string;
  let mediaRoot: string;
  let m2IdxId: string;
  let m2DcId: string;
  const servers: import("node:http").Server[] = [];

  beforeAll(async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { createServer } = await import("node:http");
    const { join: j } = await import("node:path");
    const { tmpdir: osTmp } = await import("node:os");
    const base = mkdtempSync(j(osTmp(), "mn-m2-"));
    const downloadsRoot = j(base, "downloads");
    mediaRoot = j(base, "library");
    mkdirSync(downloadsRoot, { recursive: true });
    mkdirSync(mediaRoot, { recursive: true });

    const releaseTitle = "The.Test.NS.S01E01.720p.WEB-DL.x264-GROUP";
    const nz = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        channel: { title: "mock", item: [{
          title: releaseTitle, guid: "nz-m2-1", link: "https://mock/getnzb/1.nzb",
          "newznab:attr": [{ name: "size", value: "2200000000" }, { name: "seeders", value: "9" }],
        }] },
      }));
    });
    const sab = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const u = new URL(_req.url ?? "/", "http://x");
      const mode = u.searchParams.get("mode");
      if (mode === "addurl") res.end(JSON.stringify({ status: true, nzo_ids: ["NZO-M2"] }));
      else if (mode === "queue") res.end(JSON.stringify({ queue: { slots: [] } }));
      else if (mode === "history") res.end(JSON.stringify({ history: { slots: [{ nzo_id: "NZO-M2", filename: releaseTitle, status: "Completed" }] } }));
      else res.end(JSON.stringify({ status: false }));
    });
    await new Promise<void>((r) => nz.listen(0, "127.0.0.1", () => r()));
    await new Promise<void>((r) => sab.listen(0, "127.0.0.1", () => r()));
    servers.push(nz, sab);
    newznabUrl = `http://127.0.0.1:${(nz.address() as any).port}`;
    sabUrl = `http://127.0.0.1:${(sab.address() as any).port}`;

    // a "downloaded" file for the importer to pick up
    const dir = j(downloadsRoot, "complete", releaseTitle);
    mkdirSync(dir, { recursive: true });
    writeFileSync(j(dir, `${releaseTitle}.mkv`), Buffer.alloc(2048));

    const r = await auth(request(http).put("/api/v1/system/config").send({
      "paths.downloads": downloadsRoot,
      "paths.rootFolders": [{ path: mediaRoot }],
    }));
    expect(r.status).toBe(200);
  });

  afterAll(async () => {
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
    if (m2IdxId) await auth(request(http).delete(`/api/v1/indexers/${m2IdxId}`)).catch(() => {});
    if (m2DcId) await auth(request(http).delete(`/api/v1/download-clients/${m2DcId}`)).catch(() => {});
  });

  it("auto-grabs a missing episode via rssSync, imports it, and updates want/missing + availability", async () => {
    // configure indexer + download client
    const idx = await auth(request(http).post("/api/v1/indexers").send({
      definitionKey: "generic-newznab", name: "Mock NZB M2", protocol: "usenet",
      settings: { baseUrl: newznabUrl, apiKey: "k", categories: [5000] },
    }));
    expect(idx.status).toBe(201);
    m2IdxId = idx.body.id;
    const dc = await auth(request(http).post("/api/v1/download-clients").send({
      name: "Mock SAB M2", implementation: "sabnzbd", kind: "usenet", priority: 1,
      settings: { host: sabUrl, apiKey: "k", category: "tv" },
    }));
    expect(dc.status).toBe(201);
    m2DcId = dc.body.id;

    // series with episodes: S01E01 (to grab) and S01E02 (to stay missing; upcoming)
    const series = await auth(request(http).post("/api/v1/series").send({ title: "The Test NS", tvdbId: 999001, firstAirYear: 2026 }));
    expect(series.status).toBe(201);
    const sid = series.body.id;

    const ep1 = await auth(request(http).post(`/api/v1/series/${sid}/episodes`).send({ seasonNumber: 1, episodeNumbers: [1], airDateUtc: new Date(Date.now() - 86400000).toISOString() }));
    expect(ep1.status).toBe(201);
    const tom = new Date(Date.now() + 86400000).toISOString();
    const ep2 = await auth(request(http).post(`/api/v1/series/${sid}/episodes`).send({ seasonNumber: 1, episodeNumbers: [2], airDateUtc: tom }));
    expect(ep2.status).toBe(201);

    // wanted/missing lists both episodes
    const wantedBefore = await auth(request(http).get("/api/v1/wanted/missing"));
    expect(wantedBefore.body.filter((e: any) => e.seriesId === sid).length).toBe(2);

    // run RSS sync -> should auto-grab S01E01 (mock returns only that release)
    const rss = await auth(request(http).post("/api/v1/system/commands/media.rssSync"));
    expect(rss.status).toBe(201);

    // run the download monitor to import the completed download
    await auth(request(http).post("/api/v1/system/commands/acquisition.downloadMonitor"));

    let ep1File = false;
    for (let i = 0; i < 30 && !ep1File; i++) {
      const eps = await auth(request(http).get(`/api/v1/series/${sid}/episodes`));
      ep1File = eps.body.find((e: any) => e.episode.episodeNumber === 1)?.episode.hasFile === true;
      if (!ep1File) { await auth(request(http).post("/api/v1/system/commands/acquisition.downloadMonitor")); await new Promise((rq) => setTimeout(rq, 150)); }
    }
    expect(ep1File).toBe(true);

    // availability is observable via wanted/missing: only S01E02 remains
    const wantedAfter = await auth(request(http).get("/api/v1/wanted/missing"));
    const remaining = wantedAfter.body.filter((e: any) => e.seriesId === sid);
    expect(remaining.length).toBe(1);
    expect(remaining[0].episodeNumber).toBe(2);

    // history has grabbed + import_completed; media file tied to the episode
    const hist = await auth(request(http).get("/api/v1/history"));
    const actions = hist.body.items.map((h: any) => h.action);
    expect(actions).toContain("grabbed");
    expect(actions).toContain("import_completed");

    // physical file landed in <mediaRoot>/The Test NS/Season 1/
    const { readdirSync, existsSync } = await import("node:fs");
    const { join: j } = await import("node:path");
    const seasonDir = j(mediaRoot, "The Test NS", "Season 1");
    expect(existsSync(seasonDir)).toBe(true);
    const files = readdirSync(seasonDir);
    expect(files.length).toBe(1);
    expect(files[0]).toContain("S01E01");

    // calendar includes the upcoming episode
    const cal = await auth(request(http).get(`/api/v1/calendar?start=${new Date(Date.now() - 86400000).toISOString()}&end=${new Date(Date.now() + 30 * 86400000).toISOString()}`));
    expect(cal.body.some((e: any) => e.seriesId === sid && e.episodeNumber === 2)).toBe(true);

    // monitor toggle: unmonitor S01E02 -> removed from wanted
    const epRows = await auth(request(http).get(`/api/v1/series/${sid}/episodes`));
    const ep2Id = epRows.body.find((e: any) => e.episode.episodeNumber === 2).episode.id;
    const mono = await auth(request(http).put(`/api/v1/series/${sid}/episodes/${ep2Id}`).send({ monitored: false }));
    expect(mono.status).toBe(200);
    const wantedFinal = await auth(request(http).get("/api/v1/wanted/missing"));
    expect(wantedFinal.body.some((e: any) => e.id === ep2Id)).toBe(false);
  });
});


describe("M3: indexer health, Cardigann custom definitions, and statistics", () => {
  let nzUrl: string;
  let cgUrl: string;
  const servers: import("node:http").Server[] = [];

  beforeAll(async () => {
    const { createServer } = await import("node:http");
    const makeNzb = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ channel: { title: "m3", item: [{ title: "M3.Test.2024.1080p.WEB-DL", guid: "m3-1", link: "https://x/1.nzb", "newznab:attr": [{ name: "size", value: "9000000000" }] }] } }));
    });
    const makeCg = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<table><tbody>
        <tr class="tr"><td class="n"><a href="/d/1">M3.Tracker.S01E01.720p.HDTV</a></td><td class="s">1.5 GB</td><td class="se">99</td></tr>
      </tbody></table>`);
    });
    await new Promise<void>((r) => makeNzb.listen(0, "127.0.0.1", () => r()));
    await new Promise<void>((r) => makeCg.listen(0, "127.0.0.1", () => r()));
    servers.push(makeNzb, makeCg);
    nzUrl = `http://127.0.0.1:${(makeNzb.address() as any).port}`;
    cgUrl = `http://127.0.0.1:${(makeCg.address() as any).port}`;
  });

  afterAll(async () => {
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  });

  it("health-checks an indexer and persists status (ok + failing)", async () => {
    const idx = await auth(request(http).post("/api/v1/indexers").send({
      definitionKey: "generic-newznab", name: "M3 Health NZB", protocol: "usenet",
      settings: { baseUrl: nzUrl, apiKey: "k" },
    }));
    expect(idx.status).toBe(201);
    const id = idx.body.id;

    const ok = await auth(request(http).post(`/api/v1/indexers/${id}/test`));
    expect(ok.status).toBe(201);
    expect(ok.body.ok).toBe(true);

    // an unreachable indexer -> status error + lastError persisted
    const broken = await auth(request(http).post("/api/v1/indexers").send({
      definitionKey: "generic-newznab", name: "M3 Broken", protocol: "usenet",
      settings: { baseUrl: "http://127.0.0.1:1", apiKey: "k" },
    }));
    const bad = await auth(request(http).post(`/api/v1/indexers/${broken.body.id}/test`));
    expect(bad.body.ok).toBe(false);
    const list = await auth(request(http).get("/api/v1/indexers"));
    const row = list.body.find((i: any) => i.id === broken.body.id);
    expect(row.status).toBe("error");
    expect(row.lastError).toBeTruthy();

    // discovery.indexerRefresh job runs healthchecks across configured indexers
    const refresh = await auth(request(http).post("/api/v1/system/commands/discovery.indexerRefresh"));
    expect(refresh.status).toBe(201);
  });

  it("creates a Cardigann definition, configures an indexer from it, and searches (HTML scrape)", async () => {
    const yaml = `name: M3Tests\nsettings:\n  - name: baseUrl\n    type: text\n    default: ${cgUrl}\nsearch:\n  paths:\n    - path: /browse\n      inputs:\n        q: "${'${query.plus}'}"\n      rows: tr.tr\n      title: td.n a\n      link: td.n a@href\n      size: td.s\n      seeders: td.se`;
    const def = await auth(request(http).post("/api/v1/indexers/definitions").send({ key: "m3tests", name: "M3 Tests", protocol: "torrent", cardigannYml: yaml }));
    expect(def.status).toBe(201);

    // definition is now selectable and announces its settings schema
    const defs = await auth(request(http).get("/api/v1/indexers/definitions"));
    const custom = defs.body.find((d: any) => d.key === "m3tests");
    expect(custom).toBeTruthy();
    expect(custom.implementation).toBe("cardigann");
    expect(custom.settingsSchema?.length).toBeGreaterThanOrEqual(1);

    const idx = await auth(request(http).post("/api/v1/indexers").send({
      definitionKey: "m3tests", name: "M3 Cardigann", protocol: "torrent", settings: { baseUrl: cgUrl },
    }));
    expect(idx.status).toBe(201);

    const search = await auth(request(http).post("/api/v1/search").send({ mediaType: "series", mediaId: "unused", query: "m3" }));
    const mine = search.body.releases.find((r: any) => r.indexerName === "M3 Cardigann");
    expect(mine).toBeTruthy();
    expect(mine.title).toContain("S01E01");
    expect(mine.seeders).toBe(99);
  });

  it("reports per-indexer statistics from history", async () => {
    // self-contained: configure a memory indexer + movie + grab so statistics has data
    const idx = await auth(request(http).post("/api/v1/indexers").send({
      definitionKey: "memory", name: "M3 Stats Demo", protocol: "torrent", settings: { title: "Demo" },
    }));
    expect(idx.status).toBe(201);
    const movie = await auth(request(http).post("/api/v1/movies").send({ title: "M3 Stats Movie", tmdbId: 835555 }));
    const search = await auth(request(http).post("/api/v1/search").send({ mediaType: "movie", mediaId: movie.body.id, query: "matrix" }));
    const g = await auth(request(http).post("/api/v1/grabs").send({ mediaType: "movie", mediaId: movie.body.id, releaseId: search.body.releases[0].id }));
    expect(g.status).toBe(201);

    const stats = await auth(request(http).get("/api/v1/indexers/statistics"));
    expect(stats.status).toBe(200);
    const rows = stats.body.filter((s: any) => s.grabs > 0);
    expect(rows.length).toBeGreaterThan(0);
    // grabs are attributed to the indexer that produced the release (any of them)
    expect(stats.body.some((s: any) => s.name === "M3 Health NZB" || s.name === "M3 Stats Demo")).toBe(true);
  });
});


describe("M4: users, approval->auto-search->fulfillment, notifications, watchlist", () => {
  let nzUrl: string;
  let sabUrl: string;
  let webhookUrl: string;
  const servers: import("node:http").Server[] = [];
  const received: { type: string; payload: any }[] = [];

  beforeAll(async () => {
    const { createServer } = await import("node:http");
    const nz = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ channel: { title: "m4", item: [{ title: "The.M4.Chronicle.2026.1080p.WEB-DL", guid: "m4-1", link: "https://mock/1.nzb", "newznab:attr": [{ name: "size", value: "4000000000" }] }] } }));
    });
    const sab = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const u = new URL(_req.url ?? "/", "http://x");
      const mode = u.searchParams.get("mode");
      if (mode === "addurl") res.end(JSON.stringify({ status: true, nzo_ids: ["NZO-M4"] }));
      else if (mode === "queue") res.end(JSON.stringify({ queue: { slots: [] } }));
      else if (mode === "history") res.end(JSON.stringify({ history: { slots: [{ nzo_id: "NZO-M4", filename: "The.M4.Chronicle.2026.1080p.WEB-DL", status: "Completed" }] } }));
      else res.end(JSON.stringify({ status: false }));
    });
    const hook = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => { try { received.push(JSON.parse(body)); } catch { /* ignore */ } res.writeHead(204); res.end(); });
    });
    await new Promise<void>((r) => nz.listen(0, "127.0.0.1", () => r()));
    await new Promise<void>((r) => sab.listen(0, "127.0.0.1", () => r()));
    await new Promise<void>((r) => hook.listen(0, "127.0.0.1", () => r()));
    servers.push(nz, sab, hook);
    nzUrl = `http://127.0.0.1:${(nz.address() as any).port}`;
    sabUrl = `http://127.0.0.1:${(sab.address() as any).port}`;
    webhookUrl = `http://127.0.0.1:${(hook.address() as any).port}`;

    // paths + webhook config for THIS describe (idempotent)
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { join: j } = await import("node:path");
    const { tmpdir: osTmp } = await import("node:os");
    const base = mkdtempSync(j(osTmp(), "mn-m4-"));
    const downloadsRoot = j(base, "downloads");
    const mediaRoot = j(base, "library");
    mkdirSync(downloadsRoot, { recursive: true });
    mkdirSync(mediaRoot, { recursive: true });
    const title = "The.M4.Chronicle.2026.1080p.WEB-DL";
    const dir = j(downloadsRoot, "complete", title);
    mkdirSync(dir, { recursive: true });
    writeFileSync(j(dir, `${title}.mkv`), Buffer.alloc(2048));
    const r = await auth(request(http).put("/api/v1/system/config").send({
      "paths.downloads": downloadsRoot,
      "paths.rootFolders": [{ path: mediaRoot }],
      "notifications.webhooks": [{ url: webhookUrl, eventTypes: ["requests.request.approved", "requests.request.created", "requests.request.fulfilled", "acquisition.import.completed"] }],
    }));
    expect(r.status).toBe(200);
  });

  afterAll(async () => {
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  });

  it("enforces roles: restricted user cannot admin, and their requests auto-search on approval", async () => {
    // admin creates a restricted user + scoped key
    const user = await auth(request(http).post("/api/v1/users").send({ username: "m4-user", password: "secret-password-1", roles: ["USER"] }));
    expect(user.status).toBe(201);
    const uid = user.body.id;
    const keyRes = await auth(request(http).post(`/api/v1/users/${uid}/api-keys`).send({ name: "m4-key" }));
    expect(keyRes.status).toBe(201);
    const userKey = keyRes.body.rawKey;
    expect(userKey).toBeTruthy();
    const uk = (r: any) => r.set("X-Api-Key", userKey);

    // restricted user is not admin
    const whoami = await uk(request(http).get("/api/v1/auth/whoami"));
    expect(whoami.body.principal.isAdmin).toBe(false);
    expect((await uk(request(http).get("/api/v1/users"))).status).toBe(403);

    // configure an indexer + client so auto-search can grab
    await auth(request(http).post("/api/v1/indexers").send({
      definitionKey: "generic-newznab", name: "M4 NZB", protocol: "usenet",
      settings: { baseUrl: nzUrl, apiKey: "k" },
    }));
    await auth(request(http).post("/api/v1/download-clients").send({
      name: "M4 SAB", implementation: "sabnzbd", kind: "usenet", priority: 1,
      settings: { host: sabUrl, apiKey: "k", category: "movies" },
    }));

    // restricted user creates a request (in library as a movie)
    const movie = await auth(request(http).post("/api/v1/movies").send({ title: "The M4 Chronicle", tmdbId: 770071, releaseDate: "2026-01-01" }));
    const created = await uk(request(http).post("/api/v1/requests").send({ mediaType: "movie", mediaId: movie.body.id }));
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("pending"); // no auto-approve for USER
    const requestId = created.body.id;

    // restricted user cannot approve
    expect((await uk(request(http).post(`/api/v1/requests/${requestId}/approve`).send({}))).status).toBe(403);

    // admin approves -> event->job -> auto-search+grab -> immediately imports via monitor
    const approved = await auth(request(http).post(`/api/v1/requests/${requestId}/approve`).send({}));
    expect(approved.status).toBe(201);
    expect(approved.body.status).toBe("approved");

    // run the download monitor to import the completed sabnzbd download
    let fulfilled = false;
    for (let i = 0; i < 30 && !fulfilled; i++) {
      await auth(request(http).post("/api/v1/system/commands/acquisition.downloadMonitor")).catch(() => {});
      const rows = await auth(request(http).get("/api/v1/requests"));
      fulfilled = rows.body.some((r: any) => r.id === requestId && r.status === "fulfilled");
      if (!fulfilled) {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    expect(fulfilled).toBe(true);

    // movie now has a file and availability is available
    const got = await auth(request(http).get(`/api/v1/movies/${movie.body.id}`));
    expect(got.body.hasFile).toBe(true);

    // restricted user sees only their own requests
    const otherMovie = await auth(request(http).post("/api/v1/movies").send({ title: "M4 Other", tmdbId: 770072 }));
    await auth(request(http).post("/api/v1/requests").send({ mediaType: "movie", mediaId: otherMovie.body.id }));
    const ownList = await uk(request(http).get("/api/v1/requests"));
    expect(ownList.body.every((r: any) => r.userRequestorId === uid)).toBe(true);

    // webhook received the workflow events (async delivery — poll briefly)
    let fulfilledHook = false;
    let approvedHook = false;
    let importHook = false;
    for (let i = 0; i < 20 && !(fulfilledHook && approvedHook && importHook); i++) {
      fulfilledHook = received.some((r) => r.type === "requests.request.fulfilled" && r.payload.requestId === requestId);
      approvedHook = received.some((r) => r.type === "requests.request.approved");
      importHook = received.some((r) => r.type === "acquisition.import.completed");
      if (!(fulfilledHook && approvedHook && importHook)) await new Promise((r) => setTimeout(r, 100));
    }
    // eslint-disable-next-line no-console
    if (!(fulfilledHook && approvedHook && importHook)) console.error("M4 HOOKS:", JSON.stringify(received.map((r) => r.type)), "fulfilledFlag", fulfilledHook);
    expect(approvedHook).toBe(true);
    expect(fulfilledHook).toBe(true);
    expect(importHook).toBe(true);
  });

  it("supports watchlist + content blocklist scoped to the requesting user", async () => {
    const user = await auth(request(http).post("/api/v1/users").send({ username: "m4-watcher", password: "secret-password-2", roles: ["USER"] }));
    const keyRes = await auth(request(http).post(`/api/v1/users/${user.body.id}/api-keys`).send({ name: "wl" }));
    const uk = (r: any) => r.set("X-Api-Key", keyRes.body.rawKey);

    const movie = await auth(request(http).post("/api/v1/movies").send({ title: "Watch Me", tmdbId: 882211 }));
    await uk(request(http).post("/api/v1/watchlist").send({ mediaType: "movie", mediaId: movie.body.id }));
    const wl = await uk(request(http).get("/api/v1/watchlist"));
    expect(wl.body.some((w: any) => w.mediaId === movie.body.id)).toBe(true);

    await uk(request(http).post("/api/v1/content-blocklist").send({ mediaType: "movie", mediaId: movie.body.id }));
    expect((await uk(request(http).get("/api/v1/content-blocklist"))).body.length).toBe(1);

    await uk(request(http).delete(`/api/v1/watchlist/movie/${movie.body.id}`));
    expect((await uk(request(http).get("/api/v1/watchlist"))).body.length).toBe(0);
  });
});


describe("M5: SSE realtime, notification sinks (discord/telegram), metrics, audit", () => {
  const servers: import("node:http").Server[] = [];
  const discord: string[] = [];
  const telegram: string[] = [];

  beforeAll(async () => {
    const { createServer } = await import("node:http");
    const d = createServer((req, res) => {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { discord.push(b); res.writeHead(204); res.end(); });
    });
    const t = createServer((req, res) => {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { telegram.push(b); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true })); });
    });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", () => r()));
    await new Promise<void>((r) => t.listen(0, "127.0.0.1", () => r()));
    servers.push(d, t);
    const dUrl = `http://127.0.0.1:${(d.address() as any).port}`;
    const tUrl = `http://127.0.0.1:${(t.address() as any).port}`;

    const r = await auth(request(http).put("/api/v1/system/config").send({
      "notifications.discord": [{ webhookUrl: dUrl, eventTypes: ["requests.request.created", "acquisition.release.grabbed"] }],
      "notifications.telegram": [{ botToken: "TEST", chatId: "1", baseUrl: tUrl, eventTypes: ["requests.request.created", "acquisition.release.grabbed"] }],
    }));
    expect(r.status).toBe(200);
  });

  afterAll(async () => {
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  });

  it("streams domain events over SSE and both sinks receive a request event", async () => {
    // start the underlying http server on an ephemeral port so we can open a raw SSE fetch
    await app.listen(0);
    const port = (app.getHttpServer().address() as any).port as number;
    const ctrl = new AbortController();
    const movie = await auth(request(http).post("/api/v1/movies").send({ title: "M5 Event Movie", tmdbId: 990077 }));
    const url = `http://127.0.0.1:${port}/api/v1/events`;
    const res = await fetch(url, { headers: { "x-api-key": API_KEY }, signal: ctrl.signal });
    const reader = (res.body as ReadableStream).getReader();
    const dec = new TextDecoder();

    // trigger an event after the stream is open
    await auth(request(http).post("/api/v1/requests").send({ mediaType: "movie", mediaId: movie.body.id }));

    let buf = "";
    const deadline = Date.now() + 6000;
    let saw = false;
    try {
      while (Date.now() < deadline && !saw) {
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise<{ value: undefined; done: true }>((r2) => setTimeout(() => r2({ value: undefined as never, done: true as never }), 1500)),
        ]);
        if (done && !value) continue;
        if (done) break;
        buf += dec.decode(value, { stream: true });
        if (buf.includes("requests.request.created")) saw = true;
      }
    } finally {
      ctrl.abort();
    }
    expect(saw).toBe(true);

    // sinks received the event (async — poll briefly)
    let got = false;
    for (let i = 0; i < 20 && !got; i++) {
      got = discord.some((b) => b.includes("requests.request.created")) && telegram.some((b) => b.includes("New request"));
      if (!got) await new Promise((r2) => setTimeout(r2, 100));
    }
    expect(got).toBe(true);
  });

  it("exposes Prometheus metrics and audit log", async () => {
    const metrics = await request(http).get("/metrics");
    expect(metrics.status).toBe(200);
    expect(metrics.text).toContain("http_requests_total");
    expect(metrics.text).toMatch(/uptime_seconds \d+/);

    const audit = await auth(request(http).get("/api/v1/system/audit"));
    expect(audit.status).toBe(200);
    expect(Array.isArray(audit.body)).toBe(true);
    expect(audit.body.length).toBeGreaterThan(0);
    expect(audit.body.some((e: any) => e.action === "media.movie.added")).toBe(true);
  });
});


describe("M6: compatibility APIs — Sonarr/Radarr/Prowlarr", () => {
  it("adds + lists a series via the Sonarr v3 surface, and lists quality profiles", async () => {
    const added = await auth(request(http).post("/api/sonarr/v3/series").send({
      title: "Compat Show",
      tvdbId: 555001,
      rootFolderPath: "/data/media",
      monitored: true,
      seriesType: "standard",
    }).set("X-Api-Key", API_KEY));
    expect(added.status).toBe(201);
    const body = added.body;
    expect(body.title).toBe("Compat Show");
    expect(body.tvdbId).toBe(555001);
    expect(body.id).toBeTruthy();

    // confirm it landed in the native model
    const native = await auth(request(http).get("/api/v1/series?search=Compat"));
    expect(native.body.items.some((s: any) => s.tvdbId === 555001)).toBe(true);

    const list = await auth(request(http).get("/api/sonarr/v3/series"));
    expect(list.status).toBe(200);
    expect(list.body.some((s: any) => s.tvdbId === 555001)).toBe(true);

    const qp = await auth(request(http).get("/api/sonarr/v3/qualityprofile"));
    expect(qp.status).toBe(200);
    expect(qp.body.length).toBeGreaterThan(0);
    expect(qp.body[0].name).toBeTruthy();

    // command surface maps to native jobs
    const cmd = await auth(request(http).post("/api/sonarr/v3/command").send({ name: "RefreshSeries" }));
    expect(cmd.status).toBe(201);
    expect(cmd.body.name).toBe("RefreshSeries");
  });

  it("adds + lists a movie via the Radarr v3 surface", async () => {
    const added = await auth(request(http).post("/api/radarr/v3/movie").send({ title: "Compat Movie", tmdbId: 557001, rootFolderPath: "/data/media" }));
    expect(added.status).toBe(201);
    expect(added.body.tmdbId).toBe(557001);

    const list = await auth(request(http).get("/api/radarr/v3/movie"));
    expect(list.status).toBe(200);
    expect(list.body.some((m: any) => m.tmdbId === 557001)).toBe(true);
  });

  it("exposes configured indexers and proxies search as MediaNexus-as-Prowlarr", async () => {
    // ensure at least one configured indexer to list
    const idx = await auth(request(http).post("/api/v1/indexers").send({
      definitionKey: "memory", name: "Prowlarr Probe", protocol: "torrent", settings: { title: "Demo" },
    }));
    expect(idx.status).toBe(201);

    const indexers = await auth(request(http).get("/api/prowlarr/v1/indexer"));
    expect(indexers.status).toBe(200);
    const mine = indexers.body.find((i: any) => i.name === "Prowlarr Probe");
    expect(mine).toBeTruthy();
    expect(mine.protocol).toBe("torrent");
    expect(Array.isArray(mine.fields)).toBe(true);

    // search via the prowlarr proxy — memory provider returns canned releases
    const search = await auth(request(http).get(`/api/prowlarr/v1/indexer/${mine.id}/search?query=matrix`));
    expect(search.status).toBe(200);
    expect(Array.isArray(search.body)).toBe(true);
    const hits = search.body.filter((r: any) => r.title.toLowerCase().includes("matrix"));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].indexer).toBe("Prowlarr Probe");
    expect(hits[0].protocol).toBe("torrent");
    expect(typeof hits[0].size).toBe("number");
  });
});


describe("M6b: Seerr-compatible surface", () => {
  it("logs in via /auth/local, creates a request, and serves discover/me", async () => {
    // ensure a native movie to request
    const movie = await auth(request(http).post("/api/v1/movies").send({ title: "Seerr Target", tmdbId: 670216, releaseDate: "2021-01-01" }));
    expect(movie.status).toBe(201);

    const login = await request(http).post("/api/seerr/v1/auth/local").send({ username: "admin", password: "test-password-123" });
    expect(login.status).toBe(200);
    expect(login.body.username).toBe("admin");
    const token = login.body.token;
    expect(token).toBeTruthy();

    // resolve the session user
    const me = await request(http).get("/api/seerr/v1/auth/me").set("X-Api-Key", token);
    expect(me.status).toBe(200);
    expect(me.body.username).toBe("admin");

    // create a request for the tmdbId through the Seerr surface
    const created = await request(http).post("/api/seerr/v1/request").set("X-Api-Key", token).send({ mediaType: "movie", mediaId: "670216" });
    expect(created.status).toBe(201);
    expect(created.body.mediaId).toBe("670216");
    // admin auto-approves -> Seerr status 2 (approved)
    expect(created.body.status).toBe(2);

    // it landed in the native model
    const nativeReqs = await auth(request(http).get("/api/v1/requests"));
    expect(nativeReqs.body.some((r: any) => r.mediaId === movie.body.id)).toBe(true);

    // discover lists the movie
    const discover = await request(http).get("/api/seerr/v1/discover/movies");
    expect(discover.status).toBe(200);
    expect(discover.body.some((t: any) => t.tmdbId === 670216)).toBe(true);

    // status reports totals
    const status = await request(http).get("/api/seerr/v1/status");
    expect(status.body.totalMovies).toBeGreaterThan(0);

    // bad login -> 401
    const bad = await request(http).post("/api/seerr/v1/auth/local").send({ username: "admin", password: "wrong" });
    expect(bad.status).toBe(401);
  });
});


describe("Metadata import: TMDB (series seasons/episodes + movie enrichment)", () => {
  let tmdbUrl: string;
  const servers: import("node:http").Server[] = [];

  beforeAll(async () => {
    const { createServer } = await import("node:http");
    const srv = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const u = new URL(_req.url ?? "/", "http://x");
      const p = u.pathname;
      if (p.startsWith("/find/")) { res.end(JSON.stringify({ tv_results: [{ id: 5000 }] })); return; }
      if (p === "/tv/5000") { res.end(JSON.stringify({ id: 5000, name: "Meta Show", overview: "a show", first_air_date: "2021-01-01", genres: [{ name: "Drama" }], number_of_seasons: 1, poster_path: "/s.jpg", external_ids: { tvdb_id: 8888 } })); return; }
      const m = /^\/tv\/5000\/season\/([0-9]+)$/.exec(p);
      if (m) {
        const n = Number(m[1]);
        res.end(JSON.stringify({ season_number: n, episodes: n === 0 ? [] : [{ episode_number: 1, name: "Pilot", air_date: "2021-01-02", overview: "ep one" }] }));
        return;
      }
      const mv = /^\/movie\/([0-9]+)$/.exec(p);
      if (mv) { res.end(JSON.stringify({ id: Number(mv[1]), title: "Meta Movie", overview: "a movie", release_date: "2020-06-01", genres: [{ name: "Thriller" }], poster_path: "/m.jpg" })); return; }
      if (p === "/search/movie") { res.end(JSON.stringify({ results: [{ id: 9, title: "Dune", release_date: "2021-10-22" }] })); return; }
      if (p === "/search/tv") { res.end(JSON.stringify({ results: [{ id: 5000, name: "Meta Show", first_air_date: "2021-01-01" }] })); return; }
      res.end(JSON.stringify({}));
    });
    servers.push(srv);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    tmdbUrl = `http://127.0.0.1:${(srv.address() as any).port}`;

    const cfg = await auth(request(http).put("/api/v1/system/config").send({
      "metadata.tmdbApiKey": "test-key",
      "metadata.tmdbBaseUrl": tmdbUrl,
    }));
    expect(cfg.status).toBe(200);
  });

  afterAll(async () => {
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  });

  it("populates series seasons + episodes from TMDB", async () => {
    const series = await auth(request(http).post("/api/v1/series").send({ title: "Meta Show", tvdbId: 8888, firstAirYear: 2021 }));
    expect(series.status).toBe(201);
    const sid = series.body.id;

    const refreshed = await auth(request(http).post(`/api/v1/series/${sid}/metadata`));
    expect(refreshed.status).toBe(201);
    expect(refreshed.body.updated).toBe(true);
    expect(refreshed.body.episodes).toBeGreaterThanOrEqual(1);

    const episodes = await auth(request(http).get(`/api/v1/series/${sid}/episodes`));
    const ep1 = episodes.body.find((e: any) => e.seasonNumber === 1 && e.episode.episodeNumber === 1);
    expect(ep1).toBeTruthy();
    expect(ep1.episode.title).toBe("Pilot");
    expect(ep1.episode.airDateUtc).toBe("2021-01-02");
    expect(ep1.episode.monitored).toBe(true);

    const got = await auth(request(http).get(`/api/v1/series/${sid}`));
    expect(got.body.overview).toBe("a show");
    expect(got.body.genres).toContain("Drama");
  });

  it("enriches a movie and supports metadata search", async () => {
    const movie = await auth(request(http).post("/api/v1/movies").send({ title: "Meta Movie", tmdbId: 912345 }));
    const refreshed = await auth(request(http).post(`/api/v1/movies/${movie.body.id}/metadata`));
    expect(refreshed.status).toBe(201);
    const got = await auth(request(http).get(`/api/v1/movies/${movie.body.id}`));
    expect(got.body.overview).toBe("a movie");
    expect(got.body.genres).toContain("Thriller");
    expect(got.body.releaseDate).toBe("2020-06-01");

    const lookup = await auth(request(http).get("/api/v1/metadata/search?query=dune&type=movie"));
    expect(lookup.status).toBe(200);
    expect(lookup.body[0].title).toBe("Dune");
    expect(lookup.body[0].externalId).toBe("9");
  });
});


describe("M8 hardening: secrets redaction, authz gating, security headers", () => {
  it("redacts credentials in native indexer + download-client responses", async () => {
    const idx = await auth(request(http).post("/api/v1/indexers").send({
      definitionKey: "generic-newznab", name: "Sec NZB", protocol: "usenet",
      settings: { baseUrl: "https://nzb.invalid", apiKey: "supersecret-123" },
    }));
    expect(idx.status).toBe(201);
    const list = await auth(request(http).get("/api/v1/indexers"));
    const mine = list.body.find((i: any) => i.name === "Sec NZB");
    expect(mine.settings.apiKey).toBe("[REDACTED]");
    expect(String(list.text)).not.toContain("supersecret-123");

    const dc = await auth(request(http).post("/api/v1/download-clients").send({
      name: "Sec SAB", implementation: "sabnzbd", kind: "usenet", priority: 1,
      settings: { host: "https://sab.invalid", apiKey: "sab-secret-999" },
    }));
    expect(dc.status).toBe(201);
    const dcs = await auth(request(http).get("/api/v1/download-clients"));
    const mineDc = dcs.body.find((d: any) => d.name === "Sec SAB");
    expect(mineDc.settings.apiKey).toBe("[REDACTED]");
    expect(String(dcs.text)).not.toContain("sab-secret-999");
  });

  it("gates global config + metadata behind admin", async () => {
    const user = await auth(request(http).post("/api/v1/users").send({ username: "sec-user", password: "secret-password-9", roles: ["USER"] }));
    const key = (await auth(request(http).post(`/api/v1/users/${user.body.id}/api-keys`).send({ name: "sec" }))).body.rawKey;
    const uk = (r: any) => r.set("X-Api-Key", key);

    expect((await uk(request(http).get("/api/v1/system/config"))).status).toBe(403);
    expect((await uk(request(http).put("/api/v1/system/config").send({ "ui.theme": "light" }))).status).toBe(403);
    // admin still works + no secrets in config
    const adminCfg = await auth(request(http).get("/api/v1/system/config"));
    expect(adminCfg.status).toBe(200);
    expect(String(adminCfg.text)).not.toContain("supersecret-123");
  });

  it("sets security response headers", async () => {
    const res = await request(http).get("/api/v1/movies").set("X-Api-Key", API_KEY);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });
});
