// SPDX-License-Identifier: MIT
/**
 * Gap report J8 — observability fixes.
 *
 * Covers:
 *   1. The `http_request_duration_ms_sum`/`_count` fix: _sum carries the true accumulated
 *      total (not a precomputed average) and a matching _count lets consumers derive a
 *      real average. Previously _sum held the average and no _count existed.
 *   2. The `status` label now emitted on `http_requests_total` (matching its HELP text).
 *   3. The dead in-memory `job_runs_total` counter is gone (no in-memory job tracking).
 *   4. The new DB-sourced gauges render real persisted state: queue depth (per active
 *      status), provider/indexer health (consecutive failures + auto_disabled), job
 *      execution (last-run duration + seconds since last finish), disk free, library size.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, schema, type Db } from "@medianexus/database";
import { MetricsService } from "../src/observability/metrics.service";

const dir = mkdtempSync(join(tmpdir(), "mn-metrics-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });

let counter = 0;
function freshDb(): Db {
  const handle = createDb(join(dir, `m-${counter++}.db`));
  handle.runMigrations();
  handles.push(handle);
  return handle.db;
}

describe("MetricsService — J8 request counters (regression)", () => {
  it("emits status as a real label on http_requests_total", async () => {
    const m = new MetricsService();
    m.recordRequest("/api/v1/movies", "GET", 200, 5);
    m.recordRequest("/api/v1/movies", "GET", 404, 3);
    const text = await m.render();
    expect(text).toContain('http_requests_total{method="GET",route="/api/v1/movies",status="200"} 1');
    expect(text).toContain('http_requests_total{method="GET",route="/api/v1/movies",status="404"} 1');
  });

  it("http_request_duration_ms_sum is the raw total and _count matches the request count", async () => {
    const m = new MetricsService();
    m.recordRequest("/api/v1/movies", "GET", 200, 5);
    m.recordRequest("/api/v1/movies", "GET", 200, 15);
    const text = await m.render();
    // _sum = 5 + 15 = 20 (the true total, NOT 10 which would be the average)
    expect(text).toContain('http_request_duration_ms_sum{method="GET",route="/api/v1/movies"} 20');
    // _count = number of requests recorded
    expect(text).toContain('http_request_duration_ms_count{method="GET",route="/api/v1/movies"} 2');
  });

  it("no longer emits the dead in-memory job_runs_total counter", async () => {
    const m = new MetricsService();
    const text = await m.render();
    expect(text).not.toContain("job_runs_total");
  });

  it("successful summary renders even before any providers/queue rows exist (empty-table safe)", async () => {
    const db = freshDb();
    const m = new MetricsService();
    m.setDb(db);
    const text = await m.render();
    // Every gauge query must handle the empty case — no throw, and library_size is 0.
    expect(text).toContain('library_size_total{media_type="movie"} 0');
    expect(text).toContain('library_size_total{media_type="series"} 0');
    expect(text).toContain('download_queue_depth{status="queued"} 0');
  });
});

describe("MetricsService — DB-sourced gauges (J8)", () => {
  it("renders queue depth per active status, provider health, job duration/staleness, library size from the DB", async () => {
    const db = freshDb();
    const now = new Date().toISOString();

    // Queue: one active, one terminal (terminal must be excluded).
    await db.insert(schema.downloadQueueEntry).values([
      { id: "q1", mediaType: "movie", mediaId: "mv1", downloadClientId: null, downloadId: "d1", title: "A", status: "downloading", progress: 10, size: 100, remainingTime: null, errorMessage: null, data: {}, addedAt: now, updatedAt: now },
      { id: "q2", mediaType: "movie", mediaId: "mv1", downloadClientId: null, downloadId: "d2", title: "B", status: "completed", progress: 100, size: 100, remainingTime: null, errorMessage: null, data: {}, addedAt: now, updatedAt: now },
      { id: "q3", mediaType: "movie", mediaId: "mv1", downloadClientId: null, downloadId: "d3", title: "C", status: "stalled", progress: 50, size: 100, remainingTime: null, errorMessage: null, data: {}, addedAt: now, updatedAt: now },
    ] as never).run();

    // Provider health.
    await db.insert(schema.providerStatus).values({
      id: "ps1", providerType: "indexer", providerId: "idx1", consecutiveFailures: 3,
      escalationLevel: 1, disabledUntil: null, autoDisabled: true, lastError: "boom",
      lastFailureAt: now, lastSuccessAt: null, rateLimit: null, updatedAt: now,
    }).run();

    // Job execution: a succeeded and a failed run for the same jobKey + another jobKey.
    const t1 = Date.now();
    const started = new Date(t1).toISOString();
    const finished = new Date(t1 + 5000).toISOString();
    await db.insert(schema.jobRun).values([
      { id: "jr1", jobKey: "media.rssSync", status: "succeeded", trigger: "scheduled", attempt: 1, progress: 100, message: null, error: null, payload: {}, result: {}, correlationId: null, dueAt: null, startedAt: started, finishedAt: finished, createdAt: started },
      { id: "jr2", jobKey: "media.rssSync", status: "failed", trigger: "scheduled", attempt: 1, progress: 50, message: "err", error: "err", payload: {}, result: null, correlationId: null, dueAt: null, startedAt: started, finishedAt: finished, createdAt: started },
    ] as never).run();

    // Library size.
    await db.insert(schema.movie).values({
      id: "mv1", tmdbId: 1, title: "Movie", overview: "", status: "released", monitored: true,
      qualityProfileId: null, rootFolderPath: "", minimumAvailability: "announced",
      genres: [], images: [], tags: [], hasFile: false, addedAt: now, updatedAt: now,
    }).run();
    await db.insert(schema.series).values({
      id: "sr1", tvdbId: 1, title: "Show", overview: "", status: "continuing", monitored: true,
      qualityProfileId: null, rootFolderPath: "", genres: [], images: [], tags: [],
      addedAt: now, updatedAt: now,
    }).run();

    const m = new MetricsService();
    m.setDb(db);
    const text = await m.render();

    // Queue depth: downloading + stalled active (completed excluded).
    expect(text).toContain('download_queue_depth{status="downloading"} 1');
    expect(text).toContain('download_queue_depth{status="stalled"} 1');
    expect(text).toContain('download_queue_depth{status="queued"} 0');

    // Provider health.
    expect(text).toContain('provider_consecutive_failures{provider_type="indexer",provider_id="idx1"} 3');
    expect(text).toContain('provider_auto_disabled{provider_type="indexer",provider_id="idx1"} 1');

    // Job duration: 5s for media.rssSync.
    expect(text).toContain('job_last_run_duration_seconds{job="media.rssSync"} 5.000');
    // Seconds since last finish is a plausible non-negative number.
    expect(text).toMatch(/job_seconds_since_last_finish\{job="media\.rssSync",status="succeeded"\} \d+(\.\d+)?/);

    // Library size.
    expect(text).toContain('library_size_total{media_type="movie"} 1');
    expect(text).toContain('library_size_total{media_type="series"} 1');
  });

  it("reports the duration of the most RECENTLY finished run, not the slowest ever (J8 review fix)", async () => {
    const db = freshDb();
    const base = Date.now();
    const insert = (id: string, startedOffset: number, finishedOffset: number) =>
      db.insert(schema.jobRun).values({
        id, jobKey: "media.rssSync", status: "succeeded", trigger: "scheduled", attempt: 1,
        progress: 100, message: null, error: null, payload: {}, result: {},
        correlationId: null, dueAt: null,
        startedAt: new Date(base + startedOffset).toISOString(),
        finishedAt: new Date(base + finishedOffset).toISOString(),
        createdAt: new Date(base + startedOffset).toISOString(),
      } as never).run();

    await insert("old-slow", 0, 60_000);      // older run: 60s duration
    await insert("new-fast", 100_000, 102_000); // newer run: 2s duration

    const m = new MetricsService();
    m.setDb(db);
    const text = await m.render();

    // The last run finished later (fast, 2s) — the gauge must report THAT duration,
    // not the older 60s slow run. This discriminates correct (recent) vs buggy (max).
    expect(text).toContain('job_last_run_duration_seconds{job="media.rssSync"} 2.000');
    expect(text).not.toContain('job_last_run_duration_seconds{job="media.rssSync"} 60.000');
  });
});
