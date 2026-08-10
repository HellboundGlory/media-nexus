// SPDX-License-Identifier: MIT
import type { JobStore, JobRunRecord, JobDefinitionSnapshot } from "./types";

/** In-memory store for engine tests / demos. */
export class InMemoryJobStore implements JobStore {
  runs = new Map<string, JobRunRecord>();
  defs = new Map<string, JobDefinitionSnapshot>();

  addDefinition(def: JobDefinitionSnapshot): void {
    this.defs.set(def.key, def);
  }

  async findDefinition(jobKey: string): Promise<JobDefinitionSnapshot | null> {
    return this.defs.get(jobKey) ?? null;
  }

  async listDefinitions(): Promise<JobDefinitionSnapshot[]> {
    return [...this.defs.values()];
  }

  async enqueue(record: JobRunRecord): Promise<JobRunRecord> {
    this.runs.set(record.id, { ...record });
    return record;
  }

  async findDue(nowIso: string, limit: number): Promise<JobRunRecord[]> {
    return [...this.runs.values()]
      .filter((r) => r.status === "queued" || r.status === "retrying")
      .filter((r) => !r.dueAt || r.dueAt <= nowIso)
      .sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""))
      .slice(0, limit);
  }

  async claim(runId: string): Promise<boolean> {
    const r = this.runs.get(runId);
    if (!r) return false;
    this.runs.set(runId, { ...r, status: "running" });
    return true;
  }

  async markStarted(runId: string, startedIso: string): Promise<void> {
    const r = this.runs.get(runId);
    if (r) this.runs.set(runId, { ...r, startedAt: startedIso });
  }

  async updateProgress(runId: string, progress: number, message?: string): Promise<void> {
    const r = this.runs.get(runId);
    if (r) this.runs.set(runId, { ...r, progress, message });
  }

  async succeed(runId: string, result: unknown, finishedIso: string): Promise<void> {
    const r = this.runs.get(runId);
    if (r) this.runs.set(runId, { ...r, status: "succeeded", result: result as Record<string, unknown>, finishedAt: finishedIso });
  }

  async fail(runId: string, error: string, _retryAtIso: string | null, finishedIso: string): Promise<void> {
    // The original run row is terminal ('failed'); retries are new enqueued rows.
    const r = this.runs.get(runId);
    if (r) this.runs.set(runId, { ...r, status: "failed", error, finishedAt: finishedIso });
  }

  async cancel(runId: string): Promise<void> {
    const r = this.runs.get(runId);
    if (r) this.runs.set(runId, { ...r, status: "cancelled" });
  }
}
