// SPDX-License-Identifier: MIT
// Activity — now 2 tabs (History / Blocklist) after the queue and wanted content moved out to
// Downloads.tsx and Wanted.tsx (NAV-1 Phase 2). Closes the last two thirds of UNI-019:
// History gains checkbox-select + "Remove Selected" (POST /history/bulk-remove), and Blocklist
// is a real tab (GET /blocklist + DELETE /blocklist/:id) where the old page had none. The
// "Auto-grab missing" RSS-sync trigger is kept as the header action.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MonitorDown, Trash2 } from "lucide-react";
import { api } from "../api/client";
import type { HistoryRow, BlocklistRow, Paged } from "../api/types";
import { Badge, EmptyState, ErrorState, formatDate, statusTone } from "../lib/ui";

type Tab = "history" | "blocklist";

export default function Activity() {
  const [tab, setTab] = useState<Tab>("history");
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const history = useQuery({ queryKey: ["history"], queryFn: () => api.get<{ items: HistoryRow[] }>("/history?limit=100") });
  const blocklist = useQuery({ queryKey: ["blocklist"], queryFn: () => api.get<Paged<BlocklistRow>>("/blocklist?pageSize=100") });

  const runRss = useMutation({
    mutationFn: () => api.post("/system/commands/media.rssSync"),
    onSuccess: () => setTimeout(() => { qc.invalidateQueries({ queryKey: ["wanted"] }); qc.invalidateQueries({ queryKey: ["history"] }); }, 700),
  });

  const removeHistory = useMutation({
    mutationFn: (ids: string[]) => api.post("/history/bulk-remove", { ids }),
    onSuccess: () => { setSelected(new Set()); qc.invalidateQueries({ queryKey: ["history"] }); },
  });
  const removeBlocklist = useMutation({ mutationFn: (id: string) => api.del(`/blocklist/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["blocklist"] }) });

  const historyRows = history.data?.items ?? [];
  const blocklistRows = blocklist.data?.items ?? [];

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-display text-2xl font-bold uppercase tracking-[0.05em] text-ink">Activity</h2>
        <p className="text-sm text-ink-dim">Recent history and blocklisted releases.</p>
      </div>

      <div className="flex w-fit items-center gap-2">
        <div className="flex w-fit gap-1 rounded-lg border border-rule bg-surface p-1">
          {(["history", "blocklist"] as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`rounded-md px-4 py-1.5 text-sm font-display font-semibold uppercase tracking-wide transition-colors ${tab === t ? "bg-accent text-accent-ink" : "text-ink-dim hover:bg-bg hover:text-ink"}`}>
              {t}
            </button>
          ))}
        </div>
        <button
          disabled={runRss.isPending}
          onClick={() => runRss.mutate()}
          className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50"
        >
          <MonitorDown className="h-3.5 w-3.5" /> {runRss.isPending ? "Syncing…" : "Auto-grab missing"}
        </button>
      </div>

      {tab === "history" && (history.isError ? <ErrorState error={history.error} onRetry={() => history.refetch()} /> : historyRows.length === 0 ? (
        <EmptyState title="No history yet" />
      ) : (
        <>
          {selected.size > 0 && (
            <button
              onClick={() => removeHistory.mutate([...selected])}
              disabled={removeHistory.isPending}
              className="inline-flex items-center gap-1.5 rounded-md bg-err/10 px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-err hover:bg-err/20 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" /> {removeHistory.isPending ? "Removing…" : `Remove Selected (${selected.size})`}
            </button>
          )}
          <div className="overflow-hidden rounded-lg border border-rule">
            <table className="w-full text-left text-sm">
              <thead className="bg-bg text-[10px] font-semibold uppercase tracking-wide text-ink-dim">
                <tr>
                  <th className="w-8 px-3 py-2"><input type="checkbox" checked={selected.size > 0 && selected.size === historyRows.length} onChange={(e) => setSelected(e.target.checked ? new Set(historyRows.map((h) => h.id)) : new Set())} className="h-4 w-4" /></th>
                  <th className="px-3 py-2">Action</th><th className="px-3 py-2">Media</th><th className="px-3 py-2">Release</th><th className="px-3 py-2">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {historyRows.map((h) => (
                  <tr key={h.id} className="hover:bg-bg/60">
                    <td className="px-3 py-2"><input type="checkbox" checked={selected.has(h.id)} onChange={() => toggle(h.id)} className="h-4 w-4" /></td>
                    <td className="px-3 py-2"><Badge tone={statusTone(h.action)}>{h.action.replace(/_/g, " ")}</Badge></td>
                    <td className="px-3 py-2 text-ink-dim">{h.mediaType} / {h.mediaId}</td>
                    <td className="max-w-sm truncate px-3 py-2">{String(h.data?.releaseTitle ?? h.data?.title ?? "—")}</td>
                    <td className="px-3 py-2 text-ink-dim">{formatDate(h.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ))}

      {tab === "blocklist" && (blocklist.isError ? <ErrorState error={blocklist.error} onRetry={() => blocklist.refetch()} /> : blocklistRows.length === 0 ? (
        <EmptyState title="No blocklisted releases" hint="Releases that fail repeatedly are blocked from being grabbed again." />
      ) : (
        <div className="overflow-hidden rounded-lg border border-rule">
          <table className="w-full text-left text-sm">
            <thead className="bg-bg text-[10px] font-semibold uppercase tracking-wide text-ink-dim">
              <tr><th className="px-3 py-2">Title</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Reason</th><th className="px-3 py-2">Blocked</th><th className="px-3 py-2 text-right">Action</th></tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {blocklistRows.map((b) => (
                <tr key={b.id} className="hover:bg-bg/60">
                  <td className="max-w-md truncate px-3 py-2 font-medium text-ink">{b.title}</td>
                  <td className="px-3 py-2"><Badge tone="neutral">{b.mediaType}</Badge></td>
                  <td className="px-3 py-2 text-ink-dim">{b.reason ?? "—"}</td>
                  <td className="px-3 py-2 text-ink-dim">{formatDate(b.createdAt)}</td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => removeBlocklist.mutate(b.id)} disabled={removeBlocklist.isPending} className="rounded p-1 text-ink-dim hover:bg-err-bg hover:text-err disabled:opacity-40" title="Un-blocklist (remove)">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
