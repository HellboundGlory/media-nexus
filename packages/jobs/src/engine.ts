// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { getCorrelationId } from "@medianexus/shared";
import type {
  JobStore, JobRunRecord, JobTrigger, JobDefinitionSnapshot,
} from "./types";
import { JobTimeoutError } from "./types";

export interface JobContext {
  runId: string;
  jobKey: string;
  payload: Record<string, unknown>;
  trigger: JobTrigger;
  requestId?: string;
  progress(percent: number, message?: string): Promise<void>;
  signal: AbortSignal;
}

export type JobHandler = (ctx: JobContext) => Promise<unknown>;

export interface JobEngineOptions {
  store: JobStore;
  workerTag?: string;
  maxWorkers?: number;
  logger?: (level: "debug" | "info" | "warn" | "error", msg: string, ctx?: Record<string, unknown>) => void;
}

/**
 * DB-backed, in-process job engine.
 *
 * - Handlers register by job key.
 * - `dispatch()` enqueues a run (queued, due now).
 * - `drain(dueLimit)` claims + executes due runs honor maxWorkers, retries with
 *   exponential backoff, enforces per-definition timeout, and persists full history
 *   (progress / message / error / result).
 * - SQLite/Postgres claim leases make this safe-ish across a single instance; Redis
 *   (BullMQ) is the documented scale-out path (see docs/architecture/jobs.md).
 */
export class JobEngine {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly inFlight = new Set<string>();
  private readonly defs = new Map<string, JobDefinitionSnapshot>();
  readonly maxWorkers: number;
  readonly workerTag: string;

  constructor(private readonly opts: JobEngineOptions) {
    this.workerTag = opts.workerTag ?? `worker-${process.pid}`;
    this.maxWorkers = opts.maxWorkers ?? 2;
  }

  register(key: string, handler: JobHandler): void {
    this.handlers.set(key, handler);
  }

  hasHandler(key: string): boolean {
    return this.handlers.has(key);
  }

  async refreshDefinitions(): Promise<void> {
    const defs = await this.opts.store.listDefinitions();
    for (const d of defs) this.defs.set(d.key, d);
  }

  async dispatch(input: {
    jobKey: string;
    trigger?: JobTrigger;
    payload?: Record<string, unknown>;
    dueInMs?: number;
  }): Promise<JobRunRecord> {
    const def = await this.opts.store.findDefinition(input.jobKey);
    if (!def) throw new Error(`[jobs] no job definition for "${input.jobKey}"`);
    const now = new Date();
    const dueAt = new Date(now.getTime() + (input.dueInMs ?? 0)).toISOString();
    return this.opts.store.enqueue({
      id: randomUUID(),
      jobKey: input.jobKey,
      status: "queued",
      trigger: input.trigger ?? "manual",
      attempt: 1,
      progress: 0,
      payload: input.payload ?? {},
      dueAt,
      correlationId: getCorrelationId() ?? input.payload?.correlationId as string | undefined,
      createdAt: now.toISOString(),
    });
  }

  /** Claim and execute due runs until the worker budget is full. */
  async drain(dueLimit = 25): Promise<number> {
    await this.refreshDefinitions();
    let executed = 0;
    while (this.inFlight.size < this.maxWorkers) {
      const due = await this.opts.store.findDue(new Date().toISOString(), dueLimit);
      if (due.length === 0) break;
      const claimed = await this.opts.store.claim(due[0].id, this.workerTag);
      if (!claimed) continue; // another worker claimed it; loop sees empty next
      this.inFlight.add(due[0].id);
      void this.execute(due[0]).finally(() => this.inFlight.delete(due[0].id));
      executed++;
    }
    return executed;
  }

  async waitIdle(): Promise<void> {
    while (this.inFlight.size > 0) await new Promise((r) => setTimeout(r, 25));
  }

  private async execute(record: JobRunRecord): Promise<void> {
    const handler = this.handlers.get(record.jobKey);
    const startedIso = new Date().toISOString();
    await this.opts.store.markStarted(record.id, startedIso).catch(() => {});

    if (!handler) {
      await this.opts.store.fail(record.id, `No handler registered for job "${record.jobKey}"`, null, new Date().toISOString());
      return;
    }

    const ac = new AbortController();
    const def = this.defs.get(record.jobKey);
    const timeoutMs = def?.timeoutMs ?? 60_000;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    // The abort signal alone is advisory: a handler that never reads ctx.signal (or is
    // blocked in a socket read) would otherwise hold its worker slot forever, and once
    // every slot is held the engine stops draining entirely. Racing the handler against
    // the deadline guarantees the slot is always released.
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        ac.abort();
        reject(new JobTimeoutError(record.jobKey, timeoutMs));
      }, timeoutMs);
    });

    const ctx: JobContext = {
      runId: record.id,
      jobKey: record.jobKey,
      payload: record.payload ?? {},
      trigger: record.trigger,
      requestId: record.correlationId,
      signal: ac.signal,
      progress: (percent, message) => this.opts.store.updateProgress(record.id, percent, message),
    };

    // Keep a reference to the handler's promise so that, when the deadline wins the race,
    // a later rejection from the abandoned handler doesn't surface as an unhandled rejection.
    const work = handler(ctx);
    work.catch(() => {});

    try {
      const result = await Promise.race([work, deadline]);
      await this.opts.store.succeed(record.id, result ?? {}, new Date().toISOString());
      this.log("info", "job succeeded", { jobKey: record.jobKey, runId: record.id });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const def2 = this.defs.get(record.jobKey);
      const maxRetries = def2?.maxRetries ?? 0;
      const backoff = def2?.retryBackoffMs ?? 0;
      if (timedOut || ac.signal.aborted) {
        await this.opts.store.timeout(record.id, error, new Date().toISOString());
        this.log("error", "job timed out", { jobKey: record.jobKey, runId: record.id, error });
        return;
      }
      const nextAttempt = record.attempt + 1;
      if (nextAttempt <= maxRetries + 1) {
        const retryAt = new Date(Date.now() + backoff * Math.pow(2, nextAttempt - 1)).toISOString();
        await this.opts.store.fail(record.id, error, retryAt, new Date().toISOString());
        // retries are new enqueued rows (due after backoff), original row is terminal 'failed'
        await this.opts.store.enqueue({
          ...record,
          id: randomUUID(),
          status: "retrying",
          attempt: nextAttempt,
          dueAt: retryAt,
          startedAt: undefined,
          finishedAt: undefined,
          error: undefined,
        }).catch(() => {});
        this.log("warn", "job failed, retrying", { jobKey: record.jobKey, runId: record.id, attempt: nextAttempt, error });
      } else {
        await this.opts.store.fail(record.id, error, null, new Date().toISOString());
        this.log("error", "job failed (retries exhausted)", { jobKey: record.jobKey, runId: record.id, error });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private log(level: "debug" | "info" | "warn" | "error", msg: string, ctx?: Record<string, unknown>) {
    this.opts.logger?.(level, msg, ctx);
  }
}
