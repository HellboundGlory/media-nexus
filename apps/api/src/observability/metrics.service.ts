// SPDX-License-Identifier: MIT
import { Injectable } from "@nestjs/common";
import { count, inArray } from "drizzle-orm";
import { schema, type Db } from "@medianexus/database";
import { LocalStorageProvider } from "@medianexus/integrations";
import { ACTIVE_QUEUE_STATUSES } from "@medianexus/domain";

/**
 * Prometheus-style counters/gauges (M5). The request counters and duration summary are
 * in-memory (matching the app's single-process model — the roadmap explicitly sizes this
 * item "Small" and does NOT ask for restart-persistence or a prom-client migration); the
 * operational gauges (queue depth, provider health, job execution, disk free, library
 * size) are sourced from real persisted state in the DB at scrape time, so they reflect
 * actual history rather than in-process tracking.
 */
@Injectable()
export class MetricsService {
  /** Request counter keyed by method+route+status (status is a real label, matching HELP). */
  private requests = new Map<string, number>();
  /** Duration summary keyed by method+route (one summary per route, not exploded by status). */
  private durations = new Map<string, { count: number; totalMs: number }>();
  private db?: Db;
  private storage = new LocalStorageProvider();

  /** Wire the DB in at bootstrap (the module-level `sharedMetrics` singleton is created
   *  without DI; the module factory calls this with the injected DB before first scrape). */
  setDb(db: Db): void {
    this.db = db;
  }

  recordRequest(route: string, method: string, status: number, ms: number): void {
    const reqKey = `${method} ${route} ${status}`;
    this.requests.set(reqKey, (this.requests.get(reqKey) ?? 0) + 1);

    const durKey = `${method} ${route}`;
    const d = this.durations.get(durKey) ?? { count: 0, totalMs: 0 };
    d.count++;
    d.totalMs += ms;
    this.durations.set(durKey, d);
  }

  /** Prometheus text exposition. DB-sourced gauges render the current DB state. */
  async render(): Promise<string> {
    const lines: string[] = [];

    lines.push("# TYPE http_requests_total counter");
    lines.push("# HELP http_requests_total Total HTTP requests by route/method/status");
    for (const [key, n] of this.requests) {
      const [method, route, status] = key.split(" ");
      lines.push(`http_requests_total{method="${method}",route="${route}",status="${status}"} ${n}`);
    }

    // J8 fix: _sum is the true accumulated total; _count is its sibling so consumers can
    // derive a real average (sum/count). Previously _sum held a precomputed average and
    // no _count existed — a mislabeled, incomplete summary.
    lines.push("# TYPE http_request_duration_ms summary");
    for (const [key, d] of this.durations) {
      const [method, route] = key.split(" ");
      lines.push(`http_request_duration_ms_sum{method="${method}",route="${route}"} ${d.totalMs}`);
      lines.push(`http_request_duration_ms_count{method="${method}",route="${route}"} ${d.count}`);
    }

    await this.renderOperational(lines);

    lines.push("# TYPE uptime_seconds gauge");
    lines.push(`uptime_seconds ${Math.round(process.uptime())}`);
    lines.push("# TYPE process_start_time gauge");
    lines.push(`process_start_time ${Math.floor(Date.now() / 1000) - Math.round(process.uptime())}`);
    return lines.join("\n") + "\n";
  }

  /** DB-sourced operational gauges (gap J8). Every query handles the empty-table case. */
  private async renderOperational(lines: string[]): Promise<void> {
    if (!this.db) return;

    const db = this.db as Db;

    // --- queue depth (one line per active status) ---
    const queueRows = await db
      .select({ status: schema.downloadQueueEntry.status, n: count() })
      .from(schema.downloadQueueEntry)
      .where(inArray(schema.downloadQueueEntry.status, [...ACTIVE_QUEUE_STATUSES]))
      .groupBy(schema.downloadQueueEntry.status);
    const queueByStatus = new Map(queueRows.map((r) => [r.status, r.n]));
    lines.push("# TYPE download_queue_depth gauge");
    for (const status of ACTIVE_QUEUE_STATUSES) {
      lines.push(`download_queue_depth{status="${status}"} ${queueByStatus.get(status) ?? 0}`);
    }

    // --- provider/indexer health ---
    const providerRows = await db.select().from(schema.providerStatus);
    lines.push("# TYPE provider_consecutive_failures gauge");
    for (const p of providerRows) {
      lines.push(`provider_consecutive_failures{provider_type="${p.providerType}",provider_id="${p.providerId}"} ${p.consecutiveFailures}`);
    }
    lines.push("# TYPE provider_auto_disabled gauge");
    for (const p of providerRows) {
      lines.push(`provider_auto_disabled{provider_type="${p.providerType}",provider_id="${p.providerId}"} ${p.autoDisabled ? 1 : 0}`);
    }

    // --- job execution (last-run duration + staleness per jobKey, from real rows) ---
    const jobRows = await db.select({
      jobKey: schema.jobRun.jobKey,
      status: schema.jobRun.status,
      startedAt: schema.jobRun.startedAt,
      finishedAt: schema.jobRun.finishedAt,
    }).from(schema.jobRun);
    // Most recent finished row per jobKey (two passes: latest finish overall for staleness,
    // latest with both timestamps for duration).
    const latestFinish = new Map<string, { finishedAt: number; status: string }>();
    const latestDuration = new Map<string, number>();
    for (const row of jobRows) {
      if (!row.finishedAt) continue;
      const fin = new Date(row.finishedAt).getTime();
      const cur = latestFinish.get(row.jobKey);
      if (!cur || fin > cur.finishedAt) latestFinish.set(row.jobKey, { finishedAt: fin, status: row.status });
      if (row.startedAt) {
        const dur = fin - new Date(row.startedAt).getTime();
        const prevDur = latestDuration.get(row.jobKey);
        if (prevDur === undefined || dur > prevDur) latestDuration.set(row.jobKey, dur);
      }
    }
    lines.push("# TYPE job_last_run_duration_seconds gauge");
    for (const [jobKey, ms] of latestDuration) {
      lines.push(`job_last_run_duration_seconds{job="${jobKey}"} ${(ms / 1000).toFixed(3)}`);
    }
    lines.push("# TYPE job_seconds_since_last_finish gauge");
    const now = Date.now();
    for (const [jobKey, { finishedAt, status }] of latestFinish) {
      lines.push(`job_seconds_since_last_finish{job="${jobKey}",status="${status}"} ${Math.max(0, (now - finishedAt) / 1000).toFixed(1)}`);
    }

    // --- disk free per distinct root-folder path (dedupe identical paths) ---
    const paths = new Set<string>();
    const rootRows = await db.select({ path: schema.rootFolder.path }).from(schema.rootFolder);
    for (const r of rootRows) paths.add(r.path);
    lines.push("# TYPE disk_free_bytes gauge");
    for (const path of paths) {
      const { free } = await this.storage.diskFree(path);
      lines.push(`disk_free_bytes{path="${path}"} ${free >= 0 ? free : 0}`);
    }

    // --- library size ---
    const movies = await db.select({ n: count() }).from(schema.movie);
    const series = await db.select({ n: count() }).from(schema.series);
    lines.push("# TYPE library_size_total gauge");
    lines.push(`library_size_total{media_type="movie"} ${movies[0]?.n ?? 0}`);
    lines.push(`library_size_total{media_type="series"} ${series[0]?.n ?? 0}`);
  }
}

/** Shared singleton so the middleware + controller + counters are one instance. */
export const sharedMetrics = new MetricsService();
