// SPDX-License-Identifier: MIT
import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import type { JobDefinitionSnapshot, JobRunRecord, JobStatus, JobStore, JobTrigger } from "@medianexus/jobs";

/**
 * Drizzle-backed JobStore — durable jobs over SQLite/Postgres. Claim is an atomic
 * guarded UPDATE (status queued|retrying -> running) so only one worker executes a run.
 */
@Injectable()
export class DrizzleJobStore implements JobStore {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  private toSnapshot(d: typeof schema.jobDefinition.$inferSelect): JobDefinitionSnapshot {
    return {
      key: d.key, name: d.name, schedule: d.schedule, enabled: d.enabled,
      timeoutMs: d.timeoutMs, maxRetries: d.maxRetries, retryBackoffMs: d.retryBackoffMs,
      priority: d.priority, concurrencyLimit: d.concurrencyLimit,
    };
  }

  async findDefinition(jobKey: string): Promise<JobDefinitionSnapshot | null> {
    const rows = await this.db.select().from(schema.jobDefinition).where(eq(schema.jobDefinition.key, jobKey)).limit(1);
    return rows[0] ? this.toSnapshot(rows[0]) : null;
  }

  async listDefinitions(): Promise<JobDefinitionSnapshot[]> {
    const rows = await this.db.select().from(schema.jobDefinition).where(eq(schema.jobDefinition.enabled, true));
    return rows.map((r) => this.toSnapshot(r));
  }

  async enqueue(record: JobRunRecord): Promise<JobRunRecord> {
    await this.db.insert(schema.jobRun).values({
      id: record.id, jobKey: record.jobKey, status: record.status, trigger: record.trigger,
      attempt: record.attempt, progress: record.progress, message: record.message ?? null,
      error: record.error ?? null, payload: record.payload ?? {}, result: record.result ?? null,
      dueAt: record.dueAt ?? null, startedAt: record.startedAt ?? null, finishedAt: record.finishedAt ?? null,
      correlationId: record.correlationId ?? null, createdAt: record.createdAt ?? new Date().toISOString(),
    });
    return record;
  }

  async findDue(nowIso: string, limit: number): Promise<JobRunRecord[]> {
    const rows = await this.db
      .select()
      .from(schema.jobRun)
      .where(and(
        or(eq(schema.jobRun.status, "queued"), eq(schema.jobRun.status, "retrying")),
        sql`(${schema.jobRun.dueAt} IS NULL OR ${schema.jobRun.dueAt} <= ${nowIso})`,
      ))
      .orderBy(asc(schema.jobRun.dueAt))
      .limit(limit);
    return rows.map((r) => this.toRecord(r));
  }

  async claim(runId: string): Promise<boolean> {
    const rows = await this.db
      .update(schema.jobRun)
      .set({ status: "running" })
      .where(and(
        eq(schema.jobRun.id, runId),
        or(eq(schema.jobRun.status, "queued"), eq(schema.jobRun.status, "retrying")),
      ))
      .returning();
    return rows.length > 0;
  }

  async markStarted(runId: string, startedIso: string): Promise<void> {
    await this.db.update(schema.jobRun).set({ startedAt: startedIso }).where(eq(schema.jobRun.id, runId));
  }

  async updateProgress(runId: string, progress: number, message?: string): Promise<void> {
    await this.db.update(schema.jobRun).set({ progress, message: message ?? null }).where(eq(schema.jobRun.id, runId));
  }

  async succeed(runId: string, result: unknown, finishedIso: string): Promise<void> {
    await this.db.update(schema.jobRun)
      .set({ status: "succeeded", result: (result ?? {}) as Record<string, unknown>, finishedAt: finishedIso, progress: 100 })
      .where(eq(schema.jobRun.id, runId));
  }

  async fail(runId: string, error: string, _retryAtIso: string | null, finishedIso: string): Promise<void> {
    // The original run row is terminal ('failed'); retries are new enqueued rows.
    await this.db.update(schema.jobRun)
      .set({ status: "failed" as JobStatus, error, finishedAt: finishedIso })
      .where(eq(schema.jobRun.id, runId));
  }

  async timeout(runId: string, error: string, finishedIso: string): Promise<void> {
    await this.db.update(schema.jobRun)
      .set({ status: "timed_out" as JobStatus, error, finishedAt: finishedIso })
      .where(eq(schema.jobRun.id, runId));
  }

  async cancel(runId: string): Promise<void> {
    await this.db.update(schema.jobRun).set({ status: "cancelled", finishedAt: new Date().toISOString() }).where(eq(schema.jobRun.id, runId));
  }

  async recentRuns(limit = 50): Promise<JobRunRecord[]> {
    const rows = await this.db.select().from(schema.jobRun).orderBy(desc(schema.jobRun.createdAt)).limit(limit);
    return rows.map((r) => this.toRecord(r));
  }

  private toRecord(r: typeof schema.jobRun.$inferSelect): JobRunRecord {
    return {
      id: r.id, jobKey: r.jobKey, status: r.status as JobStatus, trigger: r.trigger as JobTrigger, attempt: r.attempt,
      progress: r.progress, message: r.message ?? undefined, error: r.error ?? undefined,
      payload: r.payload ?? {}, result: r.result, dueAt: r.dueAt ?? undefined,
      startedAt: r.startedAt ?? undefined, finishedAt: r.finishedAt ?? undefined,
      correlationId: r.correlationId ?? undefined, createdAt: r.createdAt,
    };
  }
}
