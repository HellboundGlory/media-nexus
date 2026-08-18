// SPDX-License-Identifier: MIT
// InteractiveSearchModal — a real React modal (overlay component, not the mockup's checkbox
// CSS trick) for human-triggered release searching. Scope is the whole movie / a single
// episode / a whole season. Calls POST /api/v1/search (same shape the old SeriesDetail
// searchEp used) and renders each release, reading release.decision: approved releases get a
// working Grab; rejected ones are de-emphasized with a Rejected flag whose title lists the
// decision rejection messages, and their Grab is disabled.
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X, Download, Ban } from "lucide-react";
import { api } from "../../api/client";
import type { Release } from "../../api/types";
import { Badge, formatBytes, Spinner } from "../../lib/ui";

/** SON-025b: compact label for the strongest indexer flag a release carries, derived from its
 *  raw volume factors. Deliberately mirrors packages/domain/src/custom-formats.ts releaseFlagLabel
 *  (the web app never imports the domain package — types are mirrored in api/types.ts), so keep
 *  the 0/.25/.5/.75 and upload >1 thresholds in lockstep with it. undefined when neither factor
 *  signals a flag (the common case). */
function flagLabel(r: Release): string | undefined {
  const d = r.downloadVolumeFactor;
  if (d !== undefined) {
    if (d === 0) return "FL";
    if (d === 0.25) return "FL 75%";
    if (d === 0.5) return "FL 50%";
    if (d === 0.75) return "FL 25%";
  }
  if (r.uploadVolumeFactor !== undefined && r.uploadVolumeFactor > 1) return "2x UL";
  return undefined;
}

export interface SearchScope {
  label: string;
  mediaType: "movie" | "series";
  mediaId: string;
  query: string;
  seasons?: number[];
  episodes?: number[];
  /** Disable the season-pack/episode search when a title already has a file (movie) or the
   *  episode has one (episode search) — mirrors the old "search disabled when hasFile" rule. */
  disabled?: boolean;
}

export function InteractiveSearchModal({
  scope,
  onClose,
}: {
  scope: SearchScope;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  const doSearch = useMutation({
    mutationFn: () =>
      api.post<{ releases: Release[] }>("/search", {
        mediaType: scope.mediaType,
        mediaId: scope.mediaId,
        query: scope.query,
        seasons: scope.seasons,
        episodes: scope.episodes,
      }),
    onSuccess: (d) => { setReleases(d.releases); setSearchError(null); },
    onError: (e) => { setReleases([]); setSearchError(e instanceof Error ? e.message : "Search failed"); },
  });

  const grab = useMutation({
    mutationFn: (r: Release) =>
      api.post("/grabs", { mediaType: scope.mediaType, mediaId: scope.mediaId, releaseId: r.id, indexerId: r.indexerId, release: r }),
    onSuccess: () => {
      setReleases((prev) => prev ?? []);
      // Let the backend update propagate before refresh.
      setTimeout(() => qc.invalidateQueries({ queryKey: ["series-episodes", scope.mediaId] }), 400);
    },
  });

  // Escape closes the modal; run the search once on mount.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    void doSearch.mutateAsync();
    return () => window.removeEventListener("keydown", onKey);
    // run search once on open; scope/onClose are fixed for the modal's lifetime
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-16" onClick={onClose}>
      <div
        className="w-full max-w-3xl overflow-hidden rounded-xl border border-rule bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between border-b border-rule px-4 py-3">
          <h3 className="font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink">Interactive Search — {scope.label}</h3>
          <button onClick={onClose} className="rounded-md p-1 text-ink-dim hover:bg-bg" aria-label="Close"><X className="h-4 w-4" /></button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto p-4">
          {searchError && <p className="mb-3 text-sm text-err">{searchError}</p>}
          {doSearch.isPending ? (
            <Spinner label="Searching indexers…" />
          ) : releases?.length === 0 ? (
            <p className="text-sm text-ink-dim">No releases returned.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {releases?.map((r) => {
                const decision = r.decision;
                const rejected = !decision?.approved;
                const flag = flagLabel(r);
                return (
                  <li
                    key={r.id}
                    className={rejected
                      ? "flex items-center justify-between gap-3 rounded-lg border border-rule bg-bg/50 px-3 py-2 opacity-60"
                      : "flex items-center justify-between gap-3 rounded-lg border border-rule bg-bg px-3 py-2"}
                  >
                    <div className="min-w-0">
                      <div className="truncate">{r.title}</div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-ink-dim">
                        <span>{r.indexerName}</span>
                        <span>· {formatBytes(r.size)}</span>
                        {r.seeders != null && <span>· {r.seeders} SE</span>}
                        {flag && <Badge tone="info">{flag}</Badge>}
                        {r.quality && <span>· {r.quality.resolution}</span>}
                      </div>
                      {rejected && (
                        <div
                          className="mt-1 inline-flex items-center gap-1 rounded bg-err-bg px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-err-ink"
                          title={decision?.rejections.map((x) => x.message).join(", ") || undefined}
                        >
                          <Ban className="h-3 w-3" /> Rejected
                        </div>
                      )}
                    </div>
                    <button
                      disabled={rejected || grab.isPending}
                      onClick={() => grab.mutate(r)}
                      className="inline-flex shrink-0 items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Download className="h-3.5 w-3.5" /> {grab.isPending ? "…" : "Grab"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
