// SPDX-License-Identifier: MIT
// System > Tasks (NAV-1 Phase 4): scheduled-job definitions + run history. Fixes SON-033 —
// every job in the definitions list gets its own "Run Now" button (the trigger mutation was
// already generic; only a single hardcoded "run health check" existed before). Cancel remains
// for cancellable in-flight runs.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play } from "lucide-react";
import { api } from "../../api/client";
import type { JobRun, JobDefinition } from "../../api/types";
import { Badge, statusTone, ErrorState, formatDate } from "../../lib/ui";

const CANCELLABLE_STATUSES = new Set(["queued", "running", "retrying"]);

export function TasksTab() {
  const qc = useQueryClient();
  const runs = useQuery({ queryKey: ["job-runs"], queryFn: () => api.get<JobRun[]>("/system/jobs/runs") });
  const jobDefs = useQuery({ queryKey: ["job-defs"], queryFn: () => api.get<JobDefinition[]>("/system/jobs") });

  const trigger = useMutation({
    mutationFn: (jobKey: string) => api.post(`/system/commands/${jobKey}`),
    onSuccess: () => setTimeout(() => { qc.invalidateQueries({ queryKey: ["job-runs"] }); qc.invalidateQueries({ queryKey: ["job-defs"] }); qc.invalidateQueries({ queryKey: ["health"] }); }, 800),
  });
  const cancelRun = useMutation({ mutationFn: (id: string) => api.del(`/system/commands/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["job-runs"] }) });

  return (
    <div className="space-y-4">
      {runs.isError && <ErrorState error={runs.error} onRetry={() => runs.refetch()} />}

      <section className="rounded-xl border border-rule bg-surface p-4">
        <h3 className="mb-3 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim">Scheduled jobs</h3>
        <div className="flex flex-wrap gap-2">
          {(jobDefs.data ?? []).map((d) => {
            const overdue = d.nextRunAt ? new Date(d.nextRunAt).getTime() <= Date.now() : false;
            const running = trigger.isPending && trigger.variables === d.key;
            return (
              <span key={d.key} className="flex items-center gap-1.5 rounded-full border border-rule bg-bg px-2.5 py-1 text-xs">
                <span className="font-mono text-ink-dim">{d.key}</span>
                {d.nextRunAt ? <Badge tone={overdue ? "warn" : "neutral"}>{overdue ? "overdue" : formatDate(d.nextRunAt)}</Badge> : <Badge tone="neutral">disabled</Badge>}
                <button
                  onClick={() => trigger.mutate(d.key)}
                  disabled={!d.enabled || running}
                  title={`Run ${d.key} now`}
                  className="inline-flex items-center gap-0.5 rounded-full bg-accent px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-40"
                >
                  <Play className="h-2.5 w-2.5" /> {running ? "…" : "Run"}
                </button>
              </span>
            );
          })}
          {(jobDefs.data?.length ?? 0) === 0 && <p className="text-sm text-ink-dim">No job definitions.</p>}
        </div>
      </section>

      <section className="rounded-xl border border-rule bg-surface p-4">
        <h3 className="mb-3 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim">Job runs</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-[10px] font-semibold uppercase tracking-wide text-ink-dim">
              <tr><th className="pb-2">Job</th><th className="pb-2">Status</th><th className="pb-2">Trigger</th><th className="pb-2">Attempt</th><th className="pb-2">Finished</th><th className="pb-2"></th></tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {(runs.data ?? []).slice(0, 15).map((r) => (
                <tr key={r.id}>
                  <td className="py-2 font-mono text-xs">{r.jobKey}</td>
                  <td className="py-2"><Badge tone={statusTone(r.status)}>{r.status}</Badge></td>
                  <td className="py-2 text-ink-dim">{r.trigger}</td>
                  <td className="py-2 text-ink-dim">{r.attempt}</td>
                  <td className="py-2 text-ink-dim">{formatDate(r.finishedAt)}</td>
                  <td className="py-2 text-right">
                    {CANCELLABLE_STATUSES.has(r.status) && (
                      <button onClick={() => cancelRun.mutate(r.id)} disabled={cancelRun.isPending} className="rounded-md px-2 py-1 text-xs font-medium text-err hover:bg-err-bg disabled:opacity-50">Cancel</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {(runs.data?.length ?? 0) === 0 && <p className="py-3 text-sm text-ink-dim">No job runs yet.</p>}
        </div>
      </section>
    </div>
  );
}
