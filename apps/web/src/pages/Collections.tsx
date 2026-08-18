// SPDX-License-Identifier: MIT
// Collections (UNI-021): tracked TMDB movie collections. Auto-appear unmonitored when a movie in
// them is added/refreshed. ONE Monitor toggle per collection (marks owned movies monitored now +
// enables auto-add of missing parts); a Select toggle + bulk Edit modal (UNI-020 pattern); each
// card shows missing-count, meta pills, and a horizontally-scrollable parts row where owned parts
// are outlined and missing parts are dimmed with an on-demand "+" add.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookMarked, CheckSquare, RefreshCw, Plus, Pencil, Search } from "lucide-react";
import { api } from "../api/client";
import type { QualityProfile, RootFolder } from "../api/types";
import { Badge, EmptyState, ErrorState } from "../lib/ui";
import { posterUrl } from "../components/detail/Poster";
import { CollectionBulkEditModal, type CollectionBulkEditPatch } from "../components/CollectionBulkEditModal";

interface CollectionPart {
  tmdbId: number;
  title: string;
  releaseDate: string | null;
  images: { coverType: string; url: string }[];
  inLibrary: boolean;
  libraryId: string | null;
}
interface CollectionRow {
  id: string;
  tmdbId: number;
  name: string;
  overview: string | null;
  images: { coverType: string; url: string }[];
  monitored: boolean;
  qualityProfileId: string | null;
  rootFolderPath: string;
  minimumAvailability: string;
  searchOnAdd: boolean;
  parts: CollectionPart[];
  missingCount?: number;
  lastSyncAt: string | null;
}

export default function Collections() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editOpen, setEditOpen] = useState(false);

  const cols = useQuery({ queryKey: ["collections"], queryFn: () => api.get<CollectionRow[]>("/collections") });
  const profilesQ = useQuery({ queryKey: ["quality-profiles"], queryFn: () => api.get<QualityProfile[]>("/quality-profiles") });
  const rootsQ = useQuery({ queryKey: ["root-folders"], queryFn: () => api.get<RootFolder[]>("/root-folders") });

  const items = (cols.data ?? []).filter((c) => c.name.toLowerCase().includes(search.trim().toLowerCase()));
  const profileName = (id: string | null) => (id ? profilesQ.data?.find((p) => p.id === id)?.name ?? null : null);
  const rootName = (path: string) => rootsQ.data?.find((r) => r.path === path)?.name ?? (path || null);

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const monitor = useMutation({
    mutationFn: ({ id, monitored }: { id: string; monitored: boolean }) => api.put(`/collections/${id}`, { monitored }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["collections"] }),
  });
  const sync = useMutation({
    mutationFn: (id: string) => api.post(`/collections/${id}/sync`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["collections"] }),
  });
  const addPart = useMutation({
    mutationFn: ({ id, tmdbId }: { id: string; tmdbId: number }) => api.post(`/collections/${id}/parts/${tmdbId}/add`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["collections"] }),
  });
  const bulkEdit = useMutation({
    mutationFn: (patch: CollectionBulkEditPatch) => api.post("/collections/bulk-edit", { ids: [...selected], ...patch }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["collections"] }); setSelected(new Set()); setEditOpen(false); },
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl font-bold uppercase tracking-[0.05em] text-ink">Collections</h2>
          <p className="text-sm text-ink-dim">{cols.data?.length ?? 0} tracked collections</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-ink-dim" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search collections…"
              className="w-56 rounded-lg border border-rule bg-surface px-3 py-1.5 pl-8 pr-3 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40" />
          </div>
          <button onClick={() => setSelecting((v) => { if (v) setSelected(new Set()); return !v; })} className="flex items-center gap-1.5 rounded-lg border border-rule bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-rule">
            <CheckSquare className="h-4 w-4" /> {selecting ? "Done" : "Select"}
          </button>
        </div>
      </div>

      {selecting && selected.size > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-rule bg-surface px-3 py-2">
          <span className="text-sm text-ink">{selected.size} selected</span>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => setEditOpen(true)} className="flex items-center gap-1.5 rounded-lg border border-rule bg-bg px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-ink hover:bg-rule"><Pencil className="h-3.5 w-3.5" /> Edit</button>
          </div>
        </div>
      )}

      {cols.isError ? <ErrorState error={cols.error} onRetry={() => cols.refetch()} /> : cols.isLoading ? (
        <p className="text-sm text-ink-dim">Loading…</p>
      ) : items.length === 0 ? (
        <EmptyState title="No collections yet" hint="Add or refresh a movie that belongs to a TMDB collection to start tracking it here." />
      ) : (
        <div className="space-y-3">
          {items.map((c) => (
            <div key={c.id} className={`rounded-xl border bg-surface p-4 ${selecting ? "" : "border-rule"}`}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  {selecting && <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} className="h-4 w-4" aria-label={`Select ${c.name}`} />}
                  <button onClick={() => monitor.mutate({ id: c.id, monitored: !c.monitored })} title={c.monitored ? "Monitored — click to stop auto-add" : "Unmonitored — click to monitor"} className={`rounded p-1 ${c.monitored ? "text-accent" : "text-ink-dim hover:text-ink"}`}>
                    <BookMarked className="h-5 w-5 fill-current" />
                  </button>
                  <h3 className="min-w-0 truncate font-display text-lg font-bold uppercase tracking-[0.04em] text-ink">{c.name}</h3>
                  <Badge tone={c.missingCount ? "warn" : "ok"}>{c.missingCount ? `${c.missingCount} missing` : "complete"}</Badge>
                </div>
                <div className="flex items-center gap-2">
                  {profileName(c.qualityProfileId) && <Badge tone="neutral">{profileName(c.qualityProfileId)}</Badge>}
                  {rootName(c.rootFolderPath) && <Badge tone="neutral">{rootName(c.rootFolderPath)}</Badge>}
                  <Badge tone="neutral">{c.minimumAvailability}</Badge>
                  {c.searchOnAdd && <Badge tone="neutral">search on add</Badge>}
                  <button onClick={() => sync.mutate(c.id)} disabled={sync.isPending && sync.variables === c.id} title="Sync now" className="rounded p-1 text-ink-dim hover:bg-rule hover:text-ink"><RefreshCw className={`h-4 w-4 ${sync.isPending && sync.variables === c.id ? "animate-spin" : ""}`} /></button>
                </div>
              </div>
              {c.overview && <p className="mt-2 line-clamp-2 text-sm text-ink-dim">{c.overview}</p>}
              <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
                {(c.parts ?? []).map((p) => {
                  const url = posterUrl(p.images);
                  return p.inLibrary ? (
                    <div key={p.tmdbId} title={p.title} className="h-20 w-14 shrink-0 overflow-hidden rounded border-2 border-accent/60">
                      {url ? <img src={url} alt={p.title} loading="lazy" className="h-full w-full object-cover" /> : <div className="flex h-full w-full items-center justify-center bg-track text-[8px] text-ink-dim">{p.title[0] ?? "?"}</div>}
                    </div>
                  ) : (
                    <div key={p.tmdbId} title={`${p.title} (missing)`} className="relative h-20 w-14 shrink-0 overflow-hidden rounded border border-rule opacity-70">
                      {url ? <img src={url} alt={p.title} loading="lazy" className="h-full w-full object-cover" /> : <div className="flex h-full w-full items-center justify-center bg-track text-[8px] text-ink-dim">{p.title[0] ?? "?"}</div>}
                      <button
                        onClick={() => addPart.mutate({ id: c.id, tmdbId: p.tmdbId })}
                        disabled={addPart.isPending && addPart.variables?.tmdbId === p.tmdbId && addPart.variables?.id === c.id}
                        title={`Add ${p.title}`}
                        className="absolute inset-0 flex items-center justify-center bg-black/40 text-white opacity-0 transition-opacity hover:opacity-100"
                      >
                        <Plus className="h-5 w-5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {editOpen && (
        <CollectionBulkEditModal
          count={selected.size}
          onSave={(patch) => bulkEdit.mutate(patch)}
          onClose={() => setEditOpen(false)}
          busy={bulkEdit.isPending}
        />
      )}
    </div>
  );
}
