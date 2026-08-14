// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { getCorrelationId } from "@medianexus/shared";
import type {
  JobStore, JobRunRecord, JobTrigger, JobDefinitionSnapshot,
} from "./types";
import { JobTimeoutError, JobCancelledError } from "./types";

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
  private readonly inFlightByKey = new Map<string, Set<string>>();
  private readonly controllers = new Map<string, { ac: AbortController; cancelled: boolean }>();
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
      // Pick the first candidate whose jobKey is still under its definition's
      // concurrencyLimit — a scheduled fire racing a manual trigger must not run two
      // in-flight rows for the same job. If the whole due batch is currently blocked,
      // break rather than loop: nothing here is claimable right now, and continuing would
      // busy-spin re-querying the same batch until the blocking run finishes.
      const candidate = due.find((r) => {
        const limit = this.defs.get(r.jobKey)?.concurrencyLimit ?? 1;
        const current = this.inFlightByKey.get(r.jobKey)?.size ?? 0;
        return current < limit;
      });
      if (!candidate) break;
      const claimed = await this.opts.store.claim(candidate.id, this.workerTag);
      if (!claimed) continue; // another worker claimed it; loop re-queries and sees it gone
      this.inFlight.add(candidate.id);
      let keySet = this.inFlightByKey.get(candidate.jobKey);
      if (!keySet) { keySet = new Set(); this.inFlightByKey.set(candidate.jobKey, keySet); }
      keySet.add(candidate.id);
      void this.execute(candidate).finally(() => {
        this.inFlight.delete(candidate.id);
        keySet!.delete(candidate.id);
      });
      executed++;
    }
    return executed;
  }

  async waitIdle(): Promise<void> {
    while (this.inFlight.size > 0) await new Promise((r) => setTimeout(r, 25));
  }

  /**
   * Cancel a run. If it's in flight, aborts its handler's signal (cooperative — a handler
   * that never reads ctx.signal keeps running in the background but its worker slot is freed
   * and the DB row is marked cancelled, same trade-off as the existing timeout behavior). If
   * it's still queued/retrying, marks it cancelled directly so it's never claimed.
   */
  async cancel(runId: string): Promise<{ cancelled: boolean }> {
    const ctrl = this.controllers.get(runId);
    if (ctrl) {
      ctrl.cancelled = true;
      ctrl.ac.abort();
      return { cancelled: true };
    }
    return { cancelled: await this.opts.store.cancelIfPending(runId) };
  }

  private async execute(record: JobRunRecord): Promise<void> {
    // Registered synchronously, before any await, so a cancel() call racing right after
    // claim() always finds either this controller or (if execute() hasn't been invoked at
    // all yet) the still-queued/retrying row via cancelIfPending — never a gap where the run
    // is already "running" in the store but not yet cancellable by either path.
    const ctrl = { ac: new AbortController(), cancelled: false };
    this.controllers.set(record.id, ctrl);
    try {
      await this.executeInner(record, ctrl);
    } finally {
      this.controllers.delete(record.id);
    }
  }

  private async executeInner(record: JobRunRecord, ctrl: { ac: AbortController; cancelled: boolean }): Promise<void> {
    const handler = this.handlers.get(record.jobKey);
    const startedIso = new Date().toISOString();
    await this.opts.store.markStarted(record.id, startedIso).catch(() => {});

    if (!handler) {
      await this.opts.store.fail(record.id, `No handler registered for job "${record.jobKey}"`, null, new Date().toISOString());
      return;
    }

    const def = this.defs.get(record.jobKey);
    const timeoutMs = def?.timeoutMs ?? 60_000;
    let timedOut = false;

    // The abort signal alone is advisory: a handler that never reads ctx.signal (or is
    // blocked in a socket read) would otherwise hold its worker slot forever, and once
    // every slot is held the engine stops draining entirely. Racing the handler against
    // this promise guarantees the slot is always released, whether the abort came from the
    // timeout firing or from an explicit JobEngine.cancel() call — timedOut/cancelled are set
    // before abort() so the catch block below can tell the two causes apart deterministically.
    // Since executeInner() reaches this point only after an earlier await (markStarted), a
    // cancel() call can already have aborted the signal by the time this listener would be
    // registered — the 'abort' event does not replay for late listeners, so check
    // signal.aborted up front rather than relying solely on the event.
    const abortReason = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(ctrl.cancelled ? new JobCancelledError(record.jobKey) : new JobTimeoutError(record.jobKey, timeoutMs));
      if (ctrl.ac.signal.aborted) { onAbort(); return; }
      ctrl.ac.signal.addEventListener("abort", onAbort, { once: true });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.ac.abort();
    }, timeoutMs);

    const ctx: JobContext = {
      runId: record.id,
      jobKey: record.jobKey,
      payload: record.payload ?? {},
      trigger: record.trigger,
      requestId: record.correlationId,
      signal: ctrl.ac.signal,
      progress: (percent, message) => this.opts.store.updateProgress(record.id, percent, message),
    };

    // Keep a reference to the handler's promise so that, when the abort reason wins the
    // race, a later rejection from the abandoned handler doesn't surface as an unhandled
    // rejection.
    const work = handler(ctx);
    work.catch(() => {});

    try {
      const result = await Promise.race([work, abortReason]);
      await this.opts.store.succeed(record.id, result ?? {}, new Date().toISOString());
      this.log("info", "job succeeded", { jobKey: record.jobKey, runId: record.id });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const def2 = this.defs.get(record.jobKey);
      const maxRetries = def2?.maxRetries ?? 0;
      const backoff = def2?.retryBackoffMs ?? 0;
      if (ctrl.cancelled) {
        await this.opts.store.cancel(record.id);
        this.log("warn", "job cancelled", { jobKey: record.jobKey, runId: record.id });
        return;
      }
      if (timedOut) {
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
