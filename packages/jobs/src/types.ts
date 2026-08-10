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
}

/** Persistence seam — implemented over Drizzle in apps/api; InMemory in tests. */
export interface JobStore {
  findDefinition(jobKey: string): Promise<JobDefinitionSnapshot | null>;
  listDefinitions(): Promise<JobDefinitionSnapshot[]>;
  enqueue(record: JobRunRecord): Promise<JobRunRecord>;
  findDue(nowIso: string, limit: number): Promise<JobRunRecord[]>;
  claim(runId: string, workerTag: string): Promise<boolean>;
  markStarted(runId: string, startedIso: string): Promise<void>;
  updateProgress(runId: string, progress: number, message?: string): Promise<void>;
  succeed(runId: string, result: unknown, finishedIso: string): Promise<void>;
  /** fail or requeue-for-retry deterministic on retryAt */
  fail(runId: string, error: string, retryAtIso: string | null, finishedIso: string): Promise<void>;
  cancel(runId: string): Promise<void>;
}
