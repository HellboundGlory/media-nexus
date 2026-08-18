// SPDX-License-Identifier: MIT
// Dashboard — rebuilt per the NAV-1 mockup: a stat row (real Movies/Series/Downloads/Storage),
// Quick Actions (Add Movie / Add Series / Import Files), and two live "Trending" rows sourced
// from the same GET /discover endpoint that powers Discover.tsx, each card's Add wired through
// the shared AddTitleModal/addFromDiscover flow. Import Files opens the real Library Import
// scan-match-import workflow inside the shared Modal shell — not a reduced preview.
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Film, Tv, Plus, FolderOpen, Check, Loader2 } from "lucide-react";
import { api } from "../api/client";
import type { DiscoverItem, DiscoverPage, Paged, Movie, Series, QueueRow, RootFolder } from "../api/types";
import { Stat, formatBytes, EmptyState, ErrorState } from "../lib/ui";
import { AddTitleModal, type AddTitleBody } from "../components/AddTitleModal";
import { Modal } from "../components/Modal";
import LibraryImport from "./LibraryImport";

/** Sum of used bytes across accessible root folders (total − free), or null if none report sizes. */
function storageUsed(roots: RootFolder[] | undefined): number | null {
  if (!roots) return null;
  let used = 0;
  let anySized = false;
  for (const r of roots) {
    if (r.totalBytes != null && r.freeBytes != null && r.totalBytes > 0) {
      used += Math.max(0, r.totalBytes - r.freeBytes);
      anySized = true;
    }
  }
  return anySized ? used : null;
}

export default function Dashboard() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [importOpen, setImportOpen] = useState(false);
  const [addModal, setAddModal] = useState<DiscoverItem | null>(null);

  const movies = useQuery({ queryKey: ["movies"], queryFn: () => api.get<Paged<Movie>>("/movies?page=1&pageSize=1") });
  const series = useQuery({ queryKey: ["series"], queryFn: () => api.get<Paged<Series>>("/series?page=1&pageSize=1") });
  const queue = useQuery({ queryKey: ["queue"], queryFn: () => api.get<{ items: QueueRow[] }>("/queue") });
  const roots = useQuery({ queryKey: ["root-folders"], queryFn: () => api.get<RootFolder[]>("/root-folders") });
  // Distinct "dashboard-trending" key prefix, deliberately not "discover" — Discover.tsx's
  // useInfiniteQuery reads the exact key ["discover", mediaType, category] (default state:
  // ["discover","movie","trending"]) as raw InfiniteData ({pages, pageParams}). Sharing a key
  // with this page's plain single-page DiscoverPage query corrupted that cache slot: whichever
  // ran first left a shape the other couldn't read, crashing Discover's page with "Cannot read
  // properties of undefined (reading 'length')" inside react-query's own hasNextPage().
  const trendingMovie = useQuery({ queryKey: ["dashboard-trending", "movie"], queryFn: () => api.get<DiscoverPage>("/discover?mediaType=movie&category=trending&page=1") });
  const trendingSeries = useQuery({ queryKey: ["dashboard-trending", "series"], queryFn: () => api.get<DiscoverPage>("/discover?mediaType=series&category=trending&page=1") });

  const used = storageUsed(roots.data);

  const add = useMutation({
    // Same add-to-library flow Discover.tsx uses: the modal's fields ride on POST /discover/add.
    mutationFn: (vars: { item: DiscoverItem; body: AddTitleBody }) =>
      api.post<{ id: string; created: boolean }>("/discover/add", {
        mediaType: vars.item.mediaType, tmdbId: vars.item.tmdbId, ...vars.body,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [addModal?.mediaType === "movie" ? "movies" : "series"] });
      setAddModal(null);
    },
  });

  const trendingMovies = (trendingMovie.data?.results ?? []).slice(0, 6);
  const trendingShows = (trendingSeries.data?.results ?? []).slice(0, 6);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-2xl font-bold uppercase tracking-[0.05em] text-ink">Welcome to MediaNexus</h2>
        <p className="text-sm text-ink-dim">Your unified media automation platform.</p>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Movies" value={movies.data?.total ?? "…"} hint="Total movies" />
        <Stat label="Series" value={series.data?.total ?? "…"} hint="Total shows" />
        <Stat label="Downloads" value={queue.data?.items.length ?? 0} hint="Active downloads" />
        <Stat label="Storage" value={used !== null ? formatBytes(used) : "—"} hint="Total storage used" />
      </div>

      <div>
        <h3 className="mb-3 font-display text-base font-semibold uppercase tracking-[0.04em] text-ink-dim">Quick Actions</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <button onClick={() => navigate("/movies")} className="flex items-center gap-3 rounded-xl border border-rule bg-surface p-4 text-left transition-colors hover:border-accent/60">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-ok-bg text-accent"><Plus className="h-5 w-5" /></span>
            <span><span className="block font-semibold text-ink">Add Movie</span><span className="block text-xs text-ink-dim">Search and add movies</span></span>
          </button>
          <button onClick={() => navigate("/series")} className="flex items-center gap-3 rounded-xl border border-rule bg-surface p-4 text-left transition-colors hover:border-accent/60">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-ok-bg text-accent"><Plus className="h-5 w-5" /></span>
            <span><span className="block font-semibold text-ink">Add Series</span><span className="block text-xs text-ink-dim">Search and add series</span></span>
          </button>
          <button onClick={() => setImportOpen(true)} className="flex items-center gap-3 rounded-xl border border-rule bg-surface p-4 text-left transition-colors hover:border-accent/60">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-ok-bg text-accent"><FolderOpen className="h-5 w-5" /></span>
            <span><span className="block font-semibold text-ink">Import Files</span><span className="block text-xs text-ink-dim">Scan and import media</span></span>
          </button>
        </div>
      </div>

      {(trendingMovie.isError || trendingSeries.isError) && (
        <ErrorState error={trendingMovie.error ?? trendingSeries.error} onRetry={() => { trendingMovie.refetch(); trendingSeries.refetch(); }} />
      )}

      <TrendingRow title="Trending Movies" items={trendingMovies} mediaType="movie" loading={trendingMovie.isLoading} onAdd={setAddModal} />
      <TrendingRow title="Trending TV" items={trendingShows} mediaType="series" loading={trendingSeries.isLoading} onAdd={setAddModal} />

      {importOpen && (
        <Modal wide title="Import Files" onClose={() => setImportOpen(false)}>
          <div className="p-4"><LibraryImport /></div>
        </Modal>
      )}

      {addModal && (
        <AddTitleModal
          mediaType={addModal.mediaType}
          title={addModal.title}
          posterUrl={addModal.posterUrl}
          overview={addModal.overview}
          isPending={add.isPending}
          error={add.error}
          lockMinimumAvailability={addModal.mediaType === "movie"}
          onClose={() => setAddModal(null)}
          onSubmit={(body) => add.mutate({ item: addModal, body })}
        />
      )}
    </div>
  );
}

function TrendingRow({ title, items, mediaType, loading, onAdd }: {
  title: string;
  items: DiscoverItem[];
  mediaType: "movie" | "series";
  loading: boolean;
  onAdd: (item: DiscoverItem) => void;
}) {
  const Icon = mediaType === "movie" ? Film : Tv;
  return (
    <div>
      <h3 className="mb-3 font-display text-base font-semibold uppercase tracking-[0.04em] text-ink-dim">{title}</h3>
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-ink-dim"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
      ) : items.length === 0 ? (
        <EmptyState title="No results" hint="Trending data isn't available right now." />
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-1">
          {items.map((item) => (
            <div key={item.tmdbId} className="w-36 shrink-0 overflow-hidden rounded-xl border border-rule bg-surface">
              <div className="flex h-44 items-center justify-center bg-track">
                {item.posterUrl ? <img src={item.posterUrl} alt={item.title} loading="lazy" className="h-full w-full object-cover" /> : <Icon className="h-6 w-6 text-ink-dim" />}
              </div>
              <div className="space-y-1.5 p-2.5">
                <p className="truncate text-sm font-medium text-ink" title={item.title}>{item.title}</p>
                <p className="text-xs text-ink-dim">{item.year ?? "—"}</p>
                {item.inLibrary ? (
                  <button disabled className="flex w-full items-center justify-center gap-1 rounded-lg bg-ok-bg px-2 py-1 text-xs font-semibold uppercase tracking-wide text-ok">
                    <Check className="h-3 w-3" /> In Library
                  </button>
                ) : (
                  <button
                    onClick={() => onAdd(item)}
                    className="flex w-full items-center justify-center gap-1 rounded-lg bg-accent px-2 py-1 text-xs font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90"
                  >
                    <Plus className="h-3 w-3" /> Add to Library
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
