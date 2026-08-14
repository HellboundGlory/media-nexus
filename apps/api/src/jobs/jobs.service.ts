// SPDX-License-Identifier: MIT
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { CronExpressionParser } from "cron-parser";
import { parseEnv } from "@medianexus/shared";
import { JobEngine, type JobHandler, type JobRunRecord, type JobTrigger } from "@medianexus/jobs";
import { DrizzleJobStore } from "./drizzle-job.store";

/**
 * Central job surface: registers handlers, dispatches runs (manual/event/scheduled),
 * runs the DB-backed engine drain loop, and fire cron schedules from the definitions table.
 */
@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobsService.name);
  private readonly engine: JobEngine;
  private readonly store: DrizzleJobStore;
  private timer?: NodeJS.Timeout;

  constructor(store: DrizzleJobStore) {
    this.store = store;
    const env = parseEnv();
    this.engine = new JobEngine({
      store,
      maxWorkers: env.JOB_CONCURRENCY,
      logger: (level, msg, ctx) => {
        const method = level === "info" ? "log" : level;
        this.logger[method](msg, ctx ?? {});
      },
    });
  }

  onModuleInit(): void {
    void this.engine.refreshDefinitions();
    void this.engine.drain().catch((e) => this.logger.error("initial drain failed", e));
    // Poll every 15s: schedule due cron jobs + drain due manual/retry runs.
    this.timer = setInterval(() => void this.tick(), 15_000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Compute the next cron occurrence for a definition, based on its persisted
   * `lastExecutedAt` (falling back to `now - 60s` only when the job has never fired). Kept
   * as a pure function of persisted state, never held in process memory, so a restart after
   * any amount of downtime correctly detects overdue work instead of silently skipping the
   * missed window (roadmap P1, gap report B11).
   */
  private computeNextRun(def: { schedule: string; lastExecutedAt?: string }, now: Date): Date {
    const base = def.lastExecutedAt ? new Date(def.lastExecutedAt) : new Date(now.getTime() - 60_000);
    return CronExpressionParser.parse(def.schedule, { currentDate: base }).next().toDate();
  }

  async tick(): Promise<void> {
    try {
      await this.engine.refreshDefinitions();
      const defs = await this.store.listDefinitions();
      const now = new Date();
      for (const def of defs) {
        if (!def.enabled || !def.schedule) continue;
        try {
          const next = this.computeNextRun(def, now);
          if (next.getTime() <= now.getTime()) {
            await this.store.recordFired(def.key, now.toISOString());
            await this.engine.dispatch({ jobKey: def.key, trigger: "scheduled" }).catch((e) => this.logger.warn(`schedule ${def.key} failed`, e));
          }
        } catch (e) {
          this.logger.warn(`cron parse failed for ${def.key} (${def.schedule})`, e as Error);
        }
      }
      await this.engine.drain();
    } catch (e) {
      this.logger.error("tick failed", e as Error);
    }
  }

  register(key: string, handler: JobHandler): void {
    this.engine.register(key, handler);
  }

  hasHandler(key: string): boolean {
    return this.engine.hasHandler(key);
  }

  async dispatch(opts: { jobKey: string; trigger?: JobTrigger; payload?: Record<string, unknown>; dueInMs?: number }): Promise<JobRunRecord> {
    const run = await this.engine.dispatch(opts);
    // trigger a drain immediately so manually-triggered jobs start promptly
    void this.engine.drain();
    return run;
  }

  async recentRuns(limit = 50): Promise<JobRunRecord[]> {
    return this.store.recentRuns(limit);
  }

  async findRun(runId: string): Promise<JobRunRecord | null> {
    return this.store.findById(runId);
  }

  async cancel(runId: string): Promise<{ cancelled: boolean }> {
    return this.engine.cancel(runId);
  }

  async definitions() {
    const defs = await this.store.listDefinitions();
    const now = new Date();
    return defs.map((def) => {
      let nextRunAt: string | undefined;
      if (def.enabled && def.schedule) {
        try {
          nextRunAt = this.computeNextRun(def, now).toISOString();
        } catch { /* malformed cron expression — tick() already logs this case */ }
      }
      return { ...def, nextRunAt };
    });
  }
}
