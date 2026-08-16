// SPDX-License-Identifier: MIT
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { SystemStatus, JobRun, QueueRow, HistoryRow } from "../api/types";
import { Stat, Badge, statusTone, formatDate, ErrorState, EmptyState } from "../lib/ui";

export default function Dashboard() {
  const status = useQuery({ queryKey: ["system-status"], queryFn: () => api.get<SystemStatus>("/system/status") });
  const runs = useQuery({ queryKey: ["job-runs"], queryFn: () => api.get<JobRun[]>("/system/jobs/runs") });
  const queue = useQuery({ queryKey: ["queue"], queryFn: () => api.get<{ items: QueueRow[] }>("/queue") });
  const history = useQuery({ queryKey: ["history"], queryFn: () => api.get<{ items: HistoryRow[] }>("/history?limit=6") });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-2xl font-bold uppercase tracking-[0.05em] text-ink">Dashboard</h2>
        <p className="text-sm text-ink-dim">Unified overview of your media automation.</p>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Database" value={status.data?.database.vendor ?? "…"} hint={status.data ? `API v${status.data.version}` : undefined} />
        <Stat label="Uptime" value={status.data ? `${Math.floor(status.data.uptimeSeconds / 60)}m` : "…"} hint={status.data ? `since ${formatDate(status.data.started)}` : undefined} />
        <Stat label="Queue" value={queue.data?.items.length ?? 0} hint="active downloads" />
        <Stat label="Recent jobs" value={runs.data?.filter((r) => r.status === "succeeded").length ?? 0} hint="succeeded (last 50)" />
      </div>

      {status.isError && <ErrorState error={status.error} onRetry={() => status.refetch()} />}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-rule bg-surface p-4">
          <h3 className="mb-3 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim">Activity</h3>
          {history.isLoading ? <p className="text-sm text-ink-dim">Loading…</p> : history.data?.items.length === 0 ? (
            <EmptyState title="No activity yet" hint="Grabs, imports and request events will appear here." />
          ) : (
            <ul className="space-y-2 text-sm">
              {history.data?.items.map((h) => (
                <li key={h.id} className="flex items-center justify-between gap-3 border-b border-rule pb-2 last:border-0">
                  <span className="truncate">{String(h.data?.releaseTitle ?? h.data?.title ?? h.action)}</span>
                  <Badge tone={statusTone(h.action)}>{h.action.replace(/_/g, " ")}</Badge>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-xl border border-rule bg-surface p-4">
          <h3 className="mb-3 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim">Recent jobs</h3>
          {runs.isLoading ? <p className="text-sm text-ink-dim">Loading…</p> : runs.data?.length === 0 ? (
            <EmptyState title="No jobs run yet" hint="Scheduled and manual jobs appear here." />
          ) : (
            <ul className="space-y-2 text-sm">
              {runs.data?.slice(0, 6).map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 border-b border-rule pb-2 last:border-0">
                  <span className="truncate font-mono text-xs">{r.jobKey}</span>
                  <span className="flex items-center gap-2">
                    <span className="text-xs text-ink-dim">{formatDate(r.finishedAt ?? r.createdAt)}</span>
                    <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
