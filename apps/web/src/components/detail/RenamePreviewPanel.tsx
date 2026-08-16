// SPDX-License-Identifier: MIT
// RenamePreviewPanel — the "Organize & Rename" modal (FILEMGMT-1, upgrading the old preview-only
// panel): fetches GET /movies|series/:id/rename-preview (now wrapped with rootPath + namingPattern),
// lets the user pick which changed files to rename (all pre-checked), and POSTs the selected ids to
// the /rename execute endpoint which physically moves the files. Unchanged rows are shown but not
// selectable. Reuses the InteractiveSearchModal shell + lib/ui states.
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen, Tag, X } from "lucide-react";
import { api } from "../../api/client";
import type { RenamePreviewEnvelope } from "../../api/types";
import { EmptyState, ErrorState, Spinner } from "../../lib/ui";

export function RenamePreviewPanel({ mediaType, mediaId, seasonNumber, onClose }: {
  mediaType: "movie" | "series";
  mediaId: string;
  /** Series season scoping — when set, only that season's files are previewed/renamed. */
  seasonNumber?: number;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const base = `/${mediaType === "movie" ? "movies" : "series"}/${mediaId}`;
  const seasonQuery = mediaType === "series" && seasonNumber !== undefined ? `?season=${seasonNumber}` : "";
  const preview = useQuery({
    queryKey: ["rename-preview", mediaType, mediaId, seasonNumber],
    queryFn: () => api.get<RenamePreviewEnvelope>(`${base}/rename-preview${seasonQuery}`),
  });

  // Which changed rows are selected — all changed rows start checked (mockup default).
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (preview.data) {
      const next: Record<string, boolean> = {};
      for (const it of preview.data.items) if (it.changed) next[it.mediaFileId] = true;
      setChecked(next);
    }
  }, [preview.data]);

  const changedRows = useMemo(() => (preview.data?.items ?? []).filter((it) => it.changed), [preview.data]);
  const selectedCount = changedRows.filter((it) => checked[it.mediaFileId]).length;
  const totalChanged = changedRows.length;
  const allSelected = totalChanged > 0 && selectedCount === totalChanged;

  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = selectedCount > 0 && selectedCount < totalChanged;
  }, [selectedCount, totalChanged]);

  const execute = useMutation({
    mutationFn: () =>
      api.post<{ renamed: number; results: { mediaFileId: string; renamed: boolean; error?: string }[] }>(
        `${base}/rename${seasonQuery}`,
        { mediaFileIds: changedRows.filter((it) => checked[it.mediaFileId]).map((it) => it.mediaFileId) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["files", mediaType, mediaId] });
      if (mediaType === "series") qc.invalidateQueries({ queryKey: ["series-episodes", mediaId] });
      onClose();
    },
  });

  const seasonLabel = mediaType === "series" && seasonNumber !== undefined ? ` · Season ${seasonNumber}` : "";

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-16" onClick={onClose}>
      <div
        className="w-full max-w-2xl overflow-hidden rounded-xl border border-rule bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between border-b border-rule px-4 py-3">
          <h3 className="font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink">Organize &amp; Rename{seasonLabel}</h3>
          <button onClick={onClose} className="rounded-md p-1 text-ink-dim hover:bg-bg" aria-label="Close"><X className="h-4 w-4" /></button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto p-4">
          {preview.isLoading ? <Spinner label="Computing preview…" />
            : preview.isError ? <ErrorState error={preview.error} onRetry={() => preview.refetch()} />
            : !preview.data || preview.data.items.length === 0 ? (
              <EmptyState title="Success! My work is done, no files to rename." hint="Every file already matches the current naming template." />
            ) : (
              <>
                {/* Info panel — calm ok-tone band, mirror of the delete modal's err-tone block. */}
                <div className="mb-3 space-y-1 rounded-lg border border-ok/40 bg-ok-bg px-3 py-2 text-xs text-ok-ink">
                  <span className="flex items-center gap-1.5"><FolderOpen className="h-3.5 w-3.5" /> All paths are relative to: <span className="font-mono">{preview.data.rootPath || "\u2014"}</span></span>
                  <span className="flex items-center gap-1.5"><Tag className="h-3.5 w-3.5" /> Naming pattern: <span className="font-mono">{preview.data.namingPattern}</span></span>
                </div>

                {/* Toolbar */}
                <div className="mb-2 flex items-center gap-2">
                  <label className="flex items-center gap-2 text-sm text-ink">
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      className="h-4 w-4"
                      checked={allSelected}
                      onChange={(e) => {
                        const next: Record<string, boolean> = {};
                        for (const it of changedRows) next[it.mediaFileId] = e.target.checked;
                        setChecked(next);
                      }}
                    />
                    <span className="font-semibold">Select all</span>
                  </label>
                  <span className="ml-auto text-xs text-ink-dim tabular-nums">{selectedCount} of {totalChanged} selected</span>
                </div>

                <ul className="space-y-2 text-sm">
                  {preview.data.items.map((f) => (
                    <li key={f.mediaFileId} className={`rounded-lg border px-3 py-2 ${f.changed ? "border-rule bg-bg" : "border-rule bg-bg/40"}`}>
                      {f.changed ? (
                        <div className="flex items-start gap-3">
                          <input
                            type="checkbox"
                            className="mt-1 h-4 w-4"
                            checked={!!checked[f.mediaFileId]}
                            onChange={(e) => setChecked((c) => ({ ...c, [f.mediaFileId]: e.target.checked }))}
                          />
                          <div className="min-w-0 flex-1 space-y-1 font-mono text-xs">
                            <div className="truncate text-err"><span className="mr-1 select-none">{"\u2212"}</span>{f.currentPath}</div>
                            <div className="truncate text-ok"><span className="mr-1 select-none">+</span>{f.newPath}</div>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center gap-3">
                          <span className="h-4 w-4 shrink-0" aria-hidden />
                          <span className="truncate font-mono text-xs text-ink-dim" title={f.currentPath}>{f.currentPath} — already correct</span>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>

                {execute.isError && <p className="mt-3 text-xs text-err">{execute.error instanceof Error ? execute.error.message : "Rename failed"}</p>}
              </>
            )}
        </div>

        <div className="flex justify-end gap-2 border-t border-rule px-4 py-3">
          <button onClick={onClose} className="rounded-lg border border-rule bg-bg px-3 py-1.5 text-sm text-ink hover:bg-rule">Close</button>
          <button
            onClick={() => execute.mutate()}
            disabled={execute.isPending || selectedCount === 0}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50"
          >
            {execute.isPending ? "Renaming…" : "Execute Rename"}
          </button>
        </div>
      </div>
    </div>
  );
}
