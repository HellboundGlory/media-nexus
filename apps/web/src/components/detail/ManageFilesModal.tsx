// SPDX-License-Identifier: MIT
// ManageFilesModal — the "Manage Files" (movie) / "Manage Episodes" (series) disk-scan screen
// (FILEMGMT-2, Sonarr/Radarr-modeled). It is NOT a bulk monitor/delete over already-tracked
// files; it reconciles disk vs DB: every untracked video file found in the title's folder and
// every stale DB row whose file has vanished. The user reviews and checks what to do, then
// Apply imports the checked untracked files (for series, only matched ones) and removes the
// checked stale rows — ONLY what's ticked. Import rows default checked; stale rows default
// unchecked (nothing destructive happens as a side effect the user didn't see — FILEMGMT-1
// convention). A series `supersedes` list is shown inline so replacing an existing file is an
// explicit, visible opt-in. Reuses the RenamePreviewPanel modal shell + lib/ui primitives.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, FolderPlus, RefreshCw, Trash2, X } from "lucide-react";
import { api } from "../../api/client";
import type { ScanPreview } from "../../api/types";
import { Badge, EmptyState, ErrorState, Spinner, formatBytes } from "../../lib/ui";

export function ManageFilesModal({
  mediaType,
  mediaId,
  seasonNumber,
  onClose,
}: {
  mediaType: "movie" | "series";
  mediaId: string;
  /** Series season scoping — omit for whole-series or movies. */
  seasonNumber?: number;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const base = `${mediaType === "movie" ? "movies" : "series"}/${mediaId}`;
  const seasonQuery = mediaType === "series" && seasonNumber !== undefined ? `?season=${seasonNumber}` : "";
  const scopeLabel = mediaType === "movie" ? "Files" : seasonNumber !== undefined ? `Episodes · Season ${seasonNumber}` : "Episodes";

  const preview = useQuery({
    queryKey: ["manage-files", mediaType, mediaId, seasonNumber],
    queryFn: () => api.get<ScanPreview>(`/${base}/manage-files${seasonQuery}`),
  });

  // Importable = a movie's every untracked file, or a series' matched (episodeIds present) ones.
  const importable = useMemo(
    () => (preview.data?.untracked ?? []).filter((u) => mediaType === "movie" || (u.episodeIds?.length ?? 0) > 0),
    [preview.data, mediaType],
  );

  // Selected sets — imports keyed by relativePath, removals keyed by mediaFileId. Imports default
  // checked (bring on-disk files in), removals default unchecked (opt-in, per FILEMGMT-1).
  const [importSel, setImportSel] = useState<Record<string, boolean>>({});
  const [removeSel, setRemoveSel] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (preview.data) {
      const im: Record<string, boolean> = {};
      for (const u of importable) im[u.relativePath] = true;
      setImportSel(im);
      setRemoveSel({});
    }
  }, [preview.data, importable]);

  const removeCount = (preview.data?.stale ?? []).filter((s) => removeSel[s.mediaFileId]).length;
  const importCount = importable.filter((u) => importSel[u.relativePath]).length;
  const anySelected = importCount + removeCount > 0;

  const data = preview.data ?? { stale: [], untracked: [] };

  const apply = useMutation({
    mutationFn: () =>
      api.post(`/${base}/manage-files/apply${seasonQuery}`, {
        removeStale: (preview.data?.stale ?? []).filter((s) => removeSel[s.mediaFileId]).map((s) => s.mediaFileId),
        importUntracked: importable.filter((u) => importSel[u.relativePath]).map((u) => u.relativePath),
      }),
    onSuccess: () => {
      if (mediaType === "movie") {
        qc.invalidateQueries({ queryKey: ["files", "movie", mediaId] });
        qc.invalidateQueries({ queryKey: ["movie", mediaId] });
      } else {
        qc.invalidateQueries({ queryKey: ["files", "series", mediaId] });
        qc.invalidateQueries({ queryKey: ["series", mediaId] });
        qc.invalidateQueries({ queryKey: ["series-episodes", mediaId] });
      }
      onClose();
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-16" onClick={onClose}>
      <div
        className="w-full max-w-3xl overflow-hidden rounded-xl border border-rule bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between border-b border-rule px-4 py-3">
          <h3 className="font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink">Manage {scopeLabel}</h3>
          <button onClick={onClose} className="rounded-md p-1 text-ink-dim hover:bg-bg" aria-label="Close"><X className="h-4 w-4" /></button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto p-4">
          {preview.isLoading ? <Spinner label="Scanning folder…" />
            : preview.isError ? <ErrorState error={preview.error} onRetry={() => preview.refetch()} />
            : data.untracked.length === 0 && data.stale.length === 0 ? (
              <EmptyState title="All files on disk are already tracked." hint="Nothing new to import and nothing missing — this folder matches the database." />
            ) : (
              <div className="space-y-5">
                {data.untracked.length > 0 && (
                  <div>
                    <div className="mb-1.5 flex items-center gap-3">
                      <span className="flex items-center gap-1.5 font-display text-xs font-semibold uppercase tracking-[0.05em] text-ink-dim">
                        <FolderPlus className="h-3.5 w-3.5" /> On disk, not tracked — import
                      </span>
                      {importable.length > 0 && (
                        <label className="ml-auto flex items-center gap-1.5 text-xs text-ink-dim">
                          <input type="checkbox" className="h-3.5 w-3.5" checked={importCount === importable.length}
                            onChange={(e) => {
                              const next: Record<string, boolean> = {};
                              for (const u of importable) next[u.relativePath] = e.target.checked;
                              setImportSel(next);
                            }} />
                          Select all
                        </label>
                      )}
                    </div>
                    <ul className="space-y-2 text-sm">
                      {data.untracked.map((u) => {
                        const hasCheckbox = mediaType === "movie" || (u.episodeIds?.length ?? 0) > 0;
                        return (
                          <li key={u.relativePath} className="rounded-lg border border-rule bg-bg px-3 py-2">
                            <div className="flex items-start gap-3">
                              {hasCheckbox ? (
                                <input type="checkbox" className="mt-1 h-4 w-4" checked={!!importSel[u.relativePath]}
                                  onChange={(e) => setImportSel((s) => ({ ...s, [u.relativePath]: e.target.checked }))} />
                              ) : (
                                <span className="mt-0.5 h-4 w-4 shrink-0"><AlertTriangle className="h-4 w-4 text-warn" /></span>
                              )}
                              <div className="min-w-0 flex-1 space-y-1">
                                <div className="flex items-center gap-2">
                                  <span className="truncate font-mono text-xs" title={u.relativePath}>{u.relativePath}</span>
                                  <Badge tone="ok">{u.quality.source} · {u.quality.resolution}</Badge>
                                  <span className="ml-auto shrink-0 text-xs text-ink-dim tabular-nums">{formatBytes(u.size)}</span>
                                </div>
                                {u.supersedes && u.supersedes.length > 0 && (
                                  <div className="flex items-center gap-1 text-[11px] text-warn">
                                    <RefreshCw className="h-3 w-3" /> Replaces:{" "}
                                    <span className="truncate font-mono">{u.supersedes.map((s) => s.relativePath).join(", ")}</span>
                                  </div>
                                )}
                                {!hasCheckbox && u.rejections && u.rejections.length > 0 && (
                                  <div className="text-[11px] text-warn">Not importable: {u.rejections[0].message}</div>
                                )}
                              </div>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}

                {data.stale.length > 0 && (
                  <div>
                    <div className="mb-1.5 flex items-center gap-1.5 font-display text-xs font-semibold uppercase tracking-[0.05em] text-ink-dim">
                      <Trash2 className="h-3.5 w-3.5" /> Tracked but missing on disk — remove
                    </div>
                    <ul className="space-y-2 text-sm">
                      {data.stale.map((s) => (
                        <li key={s.mediaFileId} className="rounded-lg border border-rule bg-bg px-3 py-2">
                          <div className="flex items-start gap-3">
                            <input type="checkbox" className="mt-1 h-4 w-4" checked={!!removeSel[s.mediaFileId]}
                              onChange={(e) => setRemoveSel((x) => ({ ...x, [s.mediaFileId]: e.target.checked }))} />
                            <span className="truncate font-mono text-xs text-err" title={s.relativePath}>{s.relativePath}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {apply.isError && <p className="text-xs text-err">{apply.error instanceof Error ? apply.error.message : "Apply failed"}</p>}
              </div>
            )}
        </div>

        <div className="flex justify-end gap-2 border-t border-rule px-4 py-3">
          <span className="mr-auto self-center text-xs text-ink-dim tabular-nums">{importCount} import · {removeCount} remove</span>
          <button onClick={onClose} className="rounded-lg border border-rule bg-bg px-3 py-1.5 text-sm text-ink hover:bg-rule">Close</button>
          <button
            onClick={() => apply.mutate()}
            disabled={apply.isPending || !anySelected}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50"
          >
            {apply.isPending ? "Applying…" : "Apply"}
          </button>
        </div>
      </div>
    </div>
  );
}
