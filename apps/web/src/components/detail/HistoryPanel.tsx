// SPDX-License-Identifier: MIT
// HistoryPanel — a title's activity history scoped to one media item, fetched via the existing
// /history endpoint's mediaType + mediaId filters (same idea as Activity.tsx's history tab but
// scoped to this title).
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import type { HistoryRow } from "../../api/types";
import { EmptyState, ErrorState, Spinner, statusTone, formatDate, formatBytes, Badge } from "../../lib/ui";

export function HistoryPanel({ mediaType, mediaId }: { mediaType: "movie" | "series"; mediaId: string }) {
  const history = useQuery({
    queryKey: ["history", mediaType, mediaId],
    queryFn: () => api.get<{ items: HistoryRow[] }>(`/history?mediaType=${mediaType}&mediaId=${mediaId}&limit=50`),
  });
  return (
    <section className="space-y-2">
      <h4 className="font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim">History</h4>
      {history.isLoading ? <Spinner />
        : history.isError ? <ErrorState error={history.error} onRetry={() => history.refetch()} />
        : history.data?.items.length === 0 ? <EmptyState title="No history yet" hint="Imports and grabs for this title show up here." />
        : (
          <div className="overflow-hidden rounded-lg border border-rule">
            <table className="w-full text-left text-sm">
              <thead className="bg-bg text-[10px] font-semibold uppercase tracking-wide text-ink-dim">
                <tr><th className="px-3 py-2">Action</th><th className="px-3 py-2">Date</th><th className="px-3 py-2">Detail</th></tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {history.data?.items.map((h) => (
                  <tr key={h.id}>
                    <td className="px-3 py-2"><Badge tone={statusTone(h.action)}>{h.action}</Badge></td>
                    <td className="px-3 py-2 text-ink-dim">{formatDate(h.createdAt)}</td>
                    <td className="px-3 py-2 text-ink-dim">
                      {(h.data as { title?: string; path?: string; size?: number }).title
                        ?? (h.data as { path?: string }).path
                        ?? ((h.data as { size?: number }).size != null ? formatBytes((h.data as { size: number }).size) : "—")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}
