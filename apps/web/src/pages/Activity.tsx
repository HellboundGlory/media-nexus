// SPDX-License-Identifier: MIT
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { HistoryRow, QueueRow, WantedItem } from "../api/types";
import { MonitorDown } from "lucide-react";
import { Badge, EmptyState, ErrorState, formatDate, formatBytes, statusTone, ProgressBar } from "../lib/ui";

type Tab = "queue" | "history" | "wanted";

export default function Activity() {
  const [tab, setTab] = useState<Tab>("queue");
  const qc = useQueryClient();
  const queue = useQuery({ queryKey: ["queue"], queryFn: () => api.get<{ items: QueueRow[] }>("/queue") });
  const history = useQuery({ queryKey: ["history"], queryFn: () => api.get<{ items: HistoryRow[] }>("/history?limit=100") });
  const wanted = useQuery({ queryKey: ["wanted"], queryFn: () => api.get<WantedItem[]>("/wanted/missing") });

  const runRss = useMutation({
    mutationFn: () => api.post("/system/commands/media.rssSync"),
    onSuccess: () => setTimeout(() => { qc.invalidateQueries({ queryKey: ["wanted"] }); qc.invalidateQueries({ queryKey: ["history"] }); }, 700),
  });

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Activity</h2>
        <p className="text-sm text-zinc-500">Downloads and history, unified across movies and series.</p>
      </div>

      <div className="flex gap-1 rounded-lg border border-zinc-200 p-1 dark:border-zinc-800 w-fit">
        {(["queue", "history", "wanted"] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`rounded-md px-4 py-1.5 text-sm font-medium capitalize ${tab === t ? "bg-violet-600 text-white" : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"}`}>
            {t}
          </button>
        ))}
        <button
          disabled={runRss.isPending}
          onClick={() => runRss.mutate()}
          className="ml-2 flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-50"
        >
          <MonitorDown className="h-3.5 w-3.5" /> {runRss.isPending ? "Syncing…" : "Auto-grab missing"}
        </button>
      </div>

      {tab === "queue" && (queue.isError ? <ErrorState error={queue.error} onRetry={() => queue.refetch()} /> : (
        queue.data?.items.length === 0 ? <EmptyState title="Queue is empty" hint="Grabbed downloads appear here while they download." /> : (
          <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-zinc-50 text-xs uppercase text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                <tr><th className="px-4 py-2.5">Title</th><th className="px-4 py-2.5">Status</th><th className="px-4 py-2.5">Progress</th><th className="px-4 py-2.5">Size</th><th className="px-4 py-2.5">Added</th></tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {queue.data?.items.map((q) => (
                  <tr key={q.id}>
                    <td className="max-w-md truncate px-4 py-2.5 font-medium">{q.title}</td>
                    <td className="px-4 py-2.5"><Badge tone={statusTone(q.status)}>{q.status}</Badge></td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <ProgressBar value={q.progress} />
                        <span className="text-xs text-ink-dim tabular-nums">{q.progress}%</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-zinc-500">{formatBytes(q.size)}</td>
                    <td className="px-4 py-2.5 text-zinc-500">{formatDate(q.addedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ))}

      {tab === "history" && (history.isError ? <ErrorState error={history.error} onRetry={() => history.refetch()} /> : (
        history.data?.items.length === 0 ? <EmptyState title="No history yet" /> : (
          <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-zinc-50 text-xs uppercase text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                <tr><th className="px-4 py-2.5">Action</th><th className="px-4 py-2.5">Media</th><th className="px-4 py-2.5">Release</th><th className="px-4 py-2.5">When</th></tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {history.data?.items.map((h) => (
                  <tr key={h.id}>
                    <td className="px-4 py-2.5"><Badge tone={statusTone(h.action)}>{h.action.replace(/_/g, " ")}</Badge></td>
                    <td className="px-4 py-2.5 text-zinc-500">{h.mediaType} / {h.mediaId}</td>
                    <td className="max-w-sm truncate px-4 py-2.5">{String(h.data?.releaseTitle ?? h.data?.title ?? "—")}</td>
                    <td className="px-4 py-2.5 text-zinc-500">{formatDate(h.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ))}

      {tab === "wanted" && (wanted.isError ? <ErrorState error={wanted.error} onRetry={() => wanted.refetch()} /> : (
        wanted.data?.length === 0 ? <EmptyState title="Nothing wanted" hint="Monitored movies and episodes without files show here — run Auto-grab missing to fetch them." /> : (
          <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-zinc-50 text-xs uppercase text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                <tr><th className="px-4 py-2.5">Title</th><th className="px-4 py-2.5">Ep</th><th className="px-4 py-2.5">Date</th><th className="px-4 py-2.5">Status</th></tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {wanted.data?.map((w) => (
                  <tr key={`${w.mediaType}-${w.id}`}>
                    <td className="px-4 py-2.5 font-medium">{w.mediaType === "series" ? w.seriesTitle : w.title}</td>
                    <td className="px-4 py-2.5">{w.mediaType === "series" ? `S${String(w.seasonNumber).padStart(2, "0")}E${String(w.episodeNumber).padStart(2, "0")}` : "—"}</td>
                    <td className="px-4 py-2.5 text-zinc-500">{(() => { const d = w.mediaType === "series" ? w.airDateUtc : w.releaseDate; return d ? formatDate(d).slice(0, 10) : "—"; })()}</td>
                    <td className="px-4 py-2.5"><Badge tone="warn">wanted</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ))}
    </div>
  );
}
