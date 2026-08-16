// SPDX-License-Identifier: MIT
// RenamePreviewPanel — fetches GET /movies|series/:id/rename-preview and shows each file's
// currentPath → newPath, distinguishing changed rows (accent + arrow) from unchanged ones
// (dim, "already correct"). Preview only — there is no apply endpoint (BE4 deliberately didn't
// build execution), so no Apply button here.
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Check } from "lucide-react";
import { api } from "../../api/client";
import type { RenamePreviewItem } from "../../api/types";
import { EmptyState, ErrorState, Spinner } from "../../lib/ui";

export function RenamePreviewPanel({ mediaType, mediaId, onClose }: { mediaType: "movie" | "series"; mediaId: string; onClose: () => void }) {
  const preview = useQuery({
    queryKey: ["rename-preview", mediaType, mediaId],
    queryFn: () => api.get<RenamePreviewItem[]>(`/${mediaType === "movie" ? "movies" : "series"}/${mediaId}/rename-preview`),
  });
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-16" onClick={onClose}>
      <div
        className="w-full max-w-2xl overflow-hidden rounded-xl border border-rule bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between border-b border-rule px-4 py-3">
          <h3 className="font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink">Rename Preview</h3>
          <button onClick={onClose} className="rounded-md p-1 text-ink-dim hover:bg-bg" aria-label="Close">✕</button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto p-4">
          {preview.isLoading ? <Spinner label="Computing preview…" />
            : preview.isError ? <ErrorState error={preview.error} onRetry={() => preview.refetch()} />
            : !preview.data || preview.data.length === 0 ? <EmptyState title="No files to preview" hint="Add a file first — a rename preview is only meaningful once the title has media." />
            : (
              <ul className="space-y-2 text-sm">
                {preview.data.map((f) => (
                  <li key={f.mediaFileId} className={`rounded-lg border px-3 py-2 ${f.changed ? "border-accent/40 bg-accent/5" : "border-rule bg-bg/40"}`}>
                    <div className="flex items-center gap-2">
                      {f.changed
                        ? <ArrowRight className="h-4 w-4 shrink-0 text-accent" />
                        : <Check className="h-4 w-4 shrink-0 text-ink-dim" />}
                      <div className="min-w-0">
                        <div className={`truncate ${f.changed ? "text-ink line-through decoration-ink-dim/50" : "text-ink-dim"}`}>{f.currentPath}</div>
                        <div className={`truncate ${f.changed ? "text-accent" : "text-ink-dim"}`}>{f.newPath}</div>
                      </div>
                    </div>
                    <div className="mt-1 pl-6 text-[10px] font-semibold uppercase tracking-wide text-ink-dim">
                      {f.changed ? "would rename" : "already correct"}
                    </div>
                  </li>
                ))}
              </ul>
            )}
        </div>
      </div>
    </div>
  );
}
