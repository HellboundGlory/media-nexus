// SPDX-License-Identifier: MIT
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "retrying" | "cancelled" | "timed_out";
export type JobTrigger = "scheduled" | "manual" | "event";

export interface JobRunRecord {
  id: string;
  jobKey: string;
  status: JobStatus;
  trigger: JobTrigger;
  attempt: number;
  progress: number;
  message?: string;
  error?: string;
  payload: Record<string, unknown>;
  result?: Record<string, unknown> | null;
  dueAt?: string;
  startedAt?: string;
  finishedAt?: string;
  correlationId?: string;
  createdAt?: string;
}

export interface JobDefinitionSnapshot {
  key: string;
  name: string;
  schedule: string;
  enabled: boolean;
  timeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
  priority: number;
  concurrencyLimit: number;
  /** Persisted so schedule due-ness survives a restart (roadmap P1, gap report B11). */
  lastExecutedAt?: string;
}

/** Persistence seam — implemented over Drizzle in apps/api; InMemory in tests. */
export interface JobStore {
  findDefinition(jobKey: string): Promise<JobDefinitionSnapshot | null>;
  listDefinitions(): Promise<JobDefinitionSnapshot[]>;
  enqueue(record: JobRunRecord): Promise<JobRunRecord>;
  findDue(nowIso: string, limit: number): Promise<JobRunRecord[]>;
  claim(runId: string, workerTag: string): Promise<boolean>;
  findById(runId: string): Promise<JobRunRecord | null>;
  markStarted(runId: string, startedIso: string): Promise<void>;
  updateProgress(runId: string, progress: number, message?: string): Promise<void>;
  succeed(runId: string, result: unknown, finishedIso: string): Promise<void>;
  /** fail or requeue-for-retry deterministic on retryAt */
  fail(runId: string, error: string, retryAtIso: string | null, finishedIso: string): Promise<void>;
  /** terminal: the run exceeded its definition's timeoutMs and was abandoned */
  timeout(runId: string, error: string, finishedIso: string): Promise<void>;
  cancel(runId: string): Promise<void>;
  /** Atomic guarded terminal transition — succeeds only if status is still queued/retrying. */
  cancelIfPending(runId: string): Promise<boolean>;
  /** Persist that a scheduled job fired, so restart-durability doesn't depend on in-process state. */
  recordFired(jobKey: string, firedAtIso: string): Promise<void>;
}

/** Thrown by the engine when a handler outlives its definition's timeoutMs. */
export class JobTimeoutError extends Error {
  constructor(public readonly jobKey: string, public readonly timeoutMs: number) {
    super(`Job "${jobKey}" exceeded its ${timeoutMs}ms timeout and was abandoned`);
    this.name = "JobTimeoutError";
  }
}

/** Thrown by the engine when a handler's run is cancelled via JobEngine.cancel(). */
export class JobCancelledError extends Error {
  constructor(public readonly jobKey: string) {
    super(`Job "${jobKey}" was cancelled`);
    this.name = "JobCancelledError";
  }
}
