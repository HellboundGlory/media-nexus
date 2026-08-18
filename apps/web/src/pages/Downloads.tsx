// SPDX-License-Identifier: MIT
// Downloads — the active grab queue (NAV-1 Phase 2), moved out of Activity.tsx's old "queue"
// tab and given the row-level manual-intervention surface that UNI-019's backend already
// supports but the old Activity never exposed: Cancel/Remove (DELETE /queue/:id), Retry
// (POST /queue/:id/retry) on failed/stalled rows, Manual Import (POST /queue/:id/manual-import,
// simple path prompt) where auto-match needs help, and checkbox-select + "Remove Selected"
// (POST /queue/bulk-remove).
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, FolderOpen, Trash2, RefreshCw } from "lucide-react";
import { api } from "../api/client";
import type { QueueRow } from "../api/types";
import { Badge, EmptyState, ErrorState, formatBytes, formatDate, ProgressBar, statusTone, FormatsBadges } from "../lib/ui";

export default function Downloads() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const queue = useQuery({ queryKey: ["queue"], queryFn: () => api.get<{ items: QueueRow[] }>("/queue") });

  const refresh = () => qc.invalidateQueries({ queryKey: ["queue"] });

  const removeOne = useMutation({ mutationFn: (id: string) => api.del(`/queue/${id}`), onSuccess: refresh });
  const bulkRemove = useMutation({
    mutationFn: (ids: string[]) => api.post("/queue/bulk-remove", { ids }),
    onSuccess: () => { setSelected(new Set()); refresh(); },
  });
  const retry = useMutation({ mutationFn: (id: string) => api.post(`/queue/${id}/retry`), onSuccess: refresh });
  const manualImport = useMutation({
    mutationFn: ({ id, path }: { id: string; path?: string }) => api.post(`/queue/${id}/manual-import`, { path }),
    onSuccess: refresh,
  });

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const askManualImport = (q: QueueRow) => {
    const path = window.prompt(`Enter the file/folder path to import "${q.title}" from (blank = the download's own path):`, "");
    if (path !== null) manualImport.mutate({ id: q.id, path: path.trim() || undefined });
  };

  // Imported/removed entries are resolved and kept server-side for lineage only (e.g. torrent
  // seed-goal tracking) -- this page is "active grabs", so they're excluded here rather than
  // lingering forever. Failed/stalled stay visible since they need the retry/manual-import
  // actions below.
  const rows = (queue.data?.items ?? []).filter((q) => q.status !== "imported" && q.status !== "removed");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-display text-2xl font-bold uppercase tracking-[0.05em] text-ink">Downloads</h2>
          <p className="text-sm text-ink-dim">Active grabs and their import progress.</p>
        </div>
        <button
          onClick={refresh}
          className="flex items-center gap-1.5 rounded-lg border border-rule bg-bg px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink hover:bg-rule"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      </div>

      {selected.size > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-rule bg-surface px-3 py-2">
          <span className="text-sm text-ink">{selected.size} selected</span>
          <button
            onClick={() => bulkRemove.mutate([...selected])}
            disabled={bulkRemove.isPending}
            className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-err/10 px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-err hover:bg-err/20 disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" /> {bulkRemove.isPending ? "Removing…" : "Remove Selected"}
          </button>
        </div>
      )}

      {queue.isError ? <ErrorState error={queue.error} onRetry={() => queue.refetch()} /> : rows.length === 0 ? (
        <EmptyState title="Queue is empty" hint="Grabbed downloads appear here while they download." />
      ) : (
        <div className="overflow-hidden rounded-lg border border-rule">
          <table className="w-full text-left text-sm">
            <thead className="bg-bg text-[10px] font-semibold uppercase tracking-wide text-ink-dim">
              <tr>
                <th className="w-8 px-3 py-2"><input type="checkbox" checked={selected.size > 0 && selected.size === rows.length} onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} className="h-4 w-4" /></th>
                <th className="px-3 py-2">Title</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Formats</th>
                <th className="px-3 py-2">Progress</th>
                <th className="px-3 py-2">Size</th>
                <th className="px-3 py-2">Added</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {rows.map((q) => {
                const failed = q.status === "failed" || q.status === "stalled";
                return (
                  <tr key={q.id} className="hover:bg-bg/60">
                    <td className="px-3 py-2"><input type="checkbox" checked={selected.has(q.id)} onChange={() => toggle(q.id)} className="h-4 w-4" /></td>
                    <td className="max-w-md truncate px-3 py-2 font-medium text-ink">{q.title}</td>
                    <td className="px-3 py-2"><Badge tone={statusTone(q.status)}>{q.status}</Badge></td>
                    <td className="px-3 py-2"><FormatsBadges formats={q.data?.matchedFormats as { id: string; name: string }[] | undefined} /></td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <ProgressBar value={q.progress} />
                        <span className="text-xs text-ink-dim tabular-nums">{q.progress}%</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-ink-dim">{formatBytes(q.size)}</td>
                    <td className="px-3 py-2 text-ink-dim">{formatDate(q.addedAt)}</td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1">
                        {failed && (
                          <button onClick={() => retry.mutate(q.id)} disabled={retry.isPending} title="Retry import" className="rounded p-1 text-ink-dim hover:bg-rule hover:text-ink disabled:opacity-40"><RotateCcw className="h-4 w-4" /></button>
                        )}
                        {failed && (
                          <button onClick={() => askManualImport(q)} disabled={manualImport.isPending} title="Manual import from a path" className="rounded p-1 text-ink-dim hover:bg-rule hover:text-ink disabled:opacity-40"><FolderOpen className="h-4 w-4" /></button>
                        )}
                        <button onClick={() => removeOne.mutate(q.id)} disabled={removeOne.isPending} title="Cancel / remove from queue" className="rounded p-1 text-ink-dim hover:bg-err-bg hover:text-err disabled:opacity-40"><Trash2 className="h-4 w-4" /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
