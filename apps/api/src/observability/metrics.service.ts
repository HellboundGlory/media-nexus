// SPDX-License-Identifier: MIT
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { map, Observable, tap } from "rxjs";

/** In-memory Prometheus-style counters (M5). */
@Injectable()
export class MetricsService {
  private requests = new Map<string, { count: number; totalMs: number }>();
  private jobRuns = new Map<string, number>();

  recordRequest(route: string, method: string, status: number, ms: number): void {
    const key = `${method} ${route}`;
    const entry = this.requests.get(key) ?? { count: 0, totalMs: 0 };
    entry.count++;
    entry.totalMs += ms;
    this.requests.set(key, entry);
  }

  recordJobRun(status: string): void {
    this.jobRuns.set(status, (this.jobRuns.get(status) ?? 0) + 1);
  }

  /** Prometheus text exposition. */
  render(): string {
    const lines: string[] = [];
    lines.push("# TYPE http_requests_total counter");
    lines.push("# HELP http_requests_total Total HTTP requests by route/method/status");
    for (const [key, v] of this.requests) {
      const [method, route] = key.split(" ");
      lines.push(`http_requests_total{method="${method}",route="${route}"} ${v.count}`);
    }
    lines.push("# TYPE http_request_duration_ms summary");
    for (const [key, v] of this.requests) {
      const [method, route] = key.split(" ");
      const avg = v.count ? (v.totalMs / v.count).toFixed(2) : "0";
      lines.push(`http_request_duration_ms_sum{method="${method}",route="${route}"} ${avg}`);
    }
    lines.push("# TYPE job_runs_total counter");
    for (const [status, c] of this.jobRuns) {
      lines.push(`job_runs_total{status="${status}"} ${c}`);
    }
    lines.push("# TYPE uptime_seconds gauge");
    lines.push(`uptime_seconds ${Math.round(process.uptime())}`);
    lines.push("# TYPE process_start_time gauge");
    lines.push(`process_start_time ${Math.floor(Date.now() / 1000) - Math.round(process.uptime())}`);
    return lines.join("\n") + "\n";
  }
}

/** Counts handled requests (used as a global interceptor). */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const start = Date.now();
    const req = context.switchToHttp().getRequest();
    const route = req.route?.path ?? (req.baseUrl + req.path);
    return next.handle().pipe(
      map((data) => {
        this.metrics.recordRequest(route, req.method, context.switchToHttp().getResponse().statusCode, Date.now() - start);
        return data;
      }),
      tap({
        error: () => this.metrics.recordRequest(route, req.method, 500, Date.now() - start),
      }),
    );
  }
}

/** Shared singleton so the middleware + controller + counters are one instance. */
export const sharedMetrics = new MetricsService();
