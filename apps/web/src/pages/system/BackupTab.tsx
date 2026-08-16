// SPDX-License-Identifier: MIT
// System > Backup (NAV-1 Phase 4): list backups (GET /system/backups) + a Backup Now trigger
// (POST /system/commands/system.backup — the same generic job-trigger pattern as Tasks). There
// is deliberately NO restore button: no restore endpoint exists, so none is implied.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DatabaseBackup, Play } from "lucide-react";
import { api } from "../../api/client";
import { EmptyState, ErrorState, formatDate, formatBytes } from "../../lib/ui";

interface BackupFile {
  name: string;
  sizeBytes: number;
  createdAt: string;
}

export function BackupTab() {
  const qc = useQueryClient();
  const backups = useQuery({ queryKey: ["backups"], queryFn: () => api.get<BackupFile[]>("/system/backups") });
  const trigger = useMutation({
    mutationFn: () => api.post("/system/commands/system.backup"),
    onSuccess: () => setTimeout(() => qc.invalidateQueries({ queryKey: ["backups"] }), 800),
  });
  const rows = backups.data ?? [];

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-rule bg-surface p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim"><DatabaseBackup className="h-4 w-4" /> Backups</h3>
          <button
            onClick={() => trigger.mutate()}
            disabled={trigger.isPending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50"
          >
            <Play className="h-3.5 w-3.5" /> {trigger.isPending ? "Backing up…" : "Backup Now"}
          </button>
        </div>
        {trigger.isError && <p className="mb-2 text-xs text-err">{trigger.error instanceof Error ? trigger.error.message : "Backup failed"}</p>}
        {backups.isError ? <ErrorState error={backups.error} onRetry={() => backups.refetch()} /> : rows.length === 0 ? (
          <EmptyState title="No backups yet" hint="Run Backup Now (or let the scheduled system.backup job run) to create one. Backing up requires a configured backup path in Media Management." />
        ) : (
          <div className="overflow-hidden rounded-lg border border-rule">
            <table className="w-full text-left text-sm">
              <thead className="bg-bg text-[10px] font-semibold uppercase tracking-wide text-ink-dim">
                <tr><th className="px-3 py-2">Name</th><th className="px-3 py-2">Size</th><th className="px-3 py-2">Created</th></tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {rows.map((b) => (
                  <tr key={b.name}>
                    <td className="px-3 py-2 font-mono text-xs text-ink">{b.name}</td>
                    <td className="px-3 py-2 text-ink-dim">{formatBytes(b.sizeBytes)}</td>
                    <td className="px-3 py-2 text-ink-dim">{formatDate(b.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-ink-dim">Restore is not available — no restore endpoint exists. Backups contain the full database (settings included).</p>
      </section>
    </div>
  );
}
