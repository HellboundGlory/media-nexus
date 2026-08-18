// SPDX-License-Identifier: MIT
import { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { CheckSquare, Search, Plus, Database, Pencil, Tag, Trash2, Wand2, LayoutGrid, Rows3, SlidersHorizontal } from "lucide-react";
import { api } from "../api/client";
import type { Movie, Paged, QualityProfile } from "../api/types";
import { Badge, EmptyState, ErrorState } from "../lib/ui";
import { useAppStore } from "../store/useAppStore";
import { AddSearchModal } from "../components/AddSearchModal";
import { BulkEditModal, type BulkEditPatch } from "../components/BulkEditModal";
import { BulkTagsModal } from "../components/BulkTagsModal";
import { BulkDeleteModal, type BulkDeleteOptions } from "../components/BulkDeleteModal";
import { MediaPosterCard, posterGridClass } from "../components/MediaPosterCard";
import { CompletenessBadge, CompletenessLegend, movieCompleteness } from "../components/Completeness";
import { OptionsModal } from "../components/OptionsModal";

interface BulkResult {
  updated: string[];
  failed: { id: string; error: string }[];
}

const selectCls = "rounded-lg border border-rule bg-surface px-2 py-1.5 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

export default function Movies() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const viewMode = useAppStore((s) => s.libraryView);
  const setViewMode = useAppStore((s) => s.setLibraryView);
  const posterSize = useAppStore((s) => s.posterSize);
  const showTitle = useAppStore((s) => s.showTitle);
  const showQualityProfile = useAppStore((s) => s.showQualityProfile);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState(""); // "" = server default (added desc)
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [filter, setFilter] = useState(""); // "" | monitored | unmonitored | missing
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [addSearchOpen, setAddSearchOpen] = useState(false);

  // ---- bulk selection (UNI-020) ----
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [bulkTagsOpen, setBulkTagsOpen] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);
  const [bulkMsgTone, setBulkMsgTone] = useState<"ok" | "err">("err");

  // UNI-028 (pagination half): incremental loading via infinite query, matching Discover.tsx.
  // Changing search/sort/sortDir/filter changes the queryKey, so React Query resets to page 1.
  const movies = useInfiniteQuery({
    queryKey: ["movies", search, sort, sortDir, filter],
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ page: String(pageParam) });
      if (search) p.set("search", search);
      if (sort) { p.set("sort", sort); p.set("sortDir", sortDir); }
      if (filter === "monitored") p.set("monitored", "true");
      else if (filter === "unmonitored") p.set("monitored", "false");
      else if (filter === "missing") p.set("filter", "missing");
      return api.get<Paged<Movie>>(`/movies?${p.toString()}`);
    },
    initialPageParam: 1,
    // Paged<T> uses {items,total,page,pageSize}; there is more when the loaded pages haven't
    // reached total yet.
    getNextPageParam: (last) => (last.page * last.pageSize < last.total ? last.page + 1 : undefined),
  });
  const profilesQuery = useQuery({ queryKey: ["quality-profiles"], queryFn: () => api.get<QualityProfile[]>("/quality-profiles") });
  const profileName = (id: string | null | undefined): string | null => id ? profilesQuery.data?.find((p) => p.id === id)?.name ?? null : null;
  const items = movies.data?.pages.flatMap((p) => p.items) ?? [];
  // The total count is identical on every page's response — page 0 is fine to read it from.
  const total = movies.data?.pages[0]?.total ?? 0;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const selectedTitles = [...selected].map((id) => items.find((m) => m.id === id)?.title ?? id);

  const finishBulk = (res: BulkResult) => {
    qc.invalidateQueries({ queryKey: ["movies"] });
    setSelected(new Set());
    setBulkEditOpen(false); setBulkTagsOpen(false); setBulkDeleteOpen(false);
    if (res.failed.length > 0) { setBulkMsgTone("err"); setBulkMsg(`${res.failed.length} item(s) failed: ${res.failed[0].error}`); }
    else setBulkMsg(null);
  };

  const bulkEdit = useMutation({
    mutationFn: (patch: BulkEditPatch) => api.post<BulkResult>("/movies/bulk-edit", { ids: [...selected], ...patch }),
    onSuccess: finishBulk,
    onError: (e) => setBulkMsg(e instanceof Error ? e.message : "Bulk edit failed"),
  });
  const bulkTags = useMutation({
    mutationFn: (vars: { tagIds: string[]; mode: "add" | "remove" | "replace" }) => api.post<BulkResult>("/movies/bulk-tags", { ids: [...selected], ...vars }),
    onSuccess: finishBulk,
    onError: (e) => setBulkMsg(e instanceof Error ? e.message : "Bulk tags failed"),
  });
  const bulkDelete = useMutation({
    mutationFn: (opts: BulkDeleteOptions) => api.post<BulkResult>("/movies/bulk-delete", { ids: [...selected], ...opts }),
    onSuccess: finishBulk,
    onError: (e) => setBulkMsg(e instanceof Error ? e.message : "Bulk delete failed"),
  });
  const bulkRename = useMutation({
    mutationFn: (ids: string[]) => api.post<{ titlesProcessed: number; filesRenamed: number; failed: { id: string; error: string }[] }>("/movies/bulk-rename", { ids }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["movies"] });
      setSelected(new Set());
      // Renaming doesn't visibly change the list (unlike Edit/Delete), so always show a success
      // summary — plus the failure count when some titles couldn't be processed.
      setBulkMsgTone(res.failed.length ? "err" : "ok");
      setBulkMsg(`Renamed ${res.filesRenamed} files across ${res.titlesProcessed} title(s)${res.failed.length ? `; ${res.failed.length} title(s) failed` : ""}`);
    },
    onError: (e) => { setBulkMsgTone("err"); setBulkMsg(e instanceof Error ? e.message : "Bulk rename failed"); },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/movies/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["movies"] }),
  });

  const meta = useMutation({
    mutationFn: (id: string) => api.post(`/movies/${id}/metadata`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["movies"] }),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl font-bold uppercase tracking-[0.05em] text-ink">Movies</h2>
          <p className="text-sm text-ink-dim">{total} titles in library</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-ink-dim" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search titles…"
              className="w-56 rounded-lg border border-rule bg-surface px-3 py-1.5 pl-8 pr-3 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40"
            />
          </div>
          <select value={sort} onChange={(e) => setSort(e.target.value)} className={selectCls} aria-label="Sort">
            <option value="">Default</option>
            <option value="title">Title</option>
            <option value="year">Year</option>
            <option value="added">Added</option>
            <option value="monitored">Monitored</option>
          </select>
          <button disabled={!sort} onClick={() => setSortDir(sortDir === "asc" ? "desc" : "asc")} title="Sort direction" aria-label="Toggle sort direction" className="flex items-center rounded-lg border border-rule bg-surface px-2 py-1.5 text-xs text-ink-dim hover:bg-rule hover:text-ink disabled:opacity-40">{sortDir === "asc" ? "↑" : "↓"}</button>
          <select value={filter} onChange={(e) => setFilter(e.target.value)} className={selectCls} aria-label="Filter">
            <option value="">All</option>
            <option value="monitored">Monitored</option>
            <option value="unmonitored">Unmonitored</option>
            <option value="missing">Missing</option>
          </select>
          <button onClick={() => setOptionsOpen(true)} title="Display options" aria-label="Display options" className="flex items-center rounded-lg border border-rule bg-surface px-2 py-1.5 text-ink-dim hover:bg-rule hover:text-ink"><SlidersHorizontal className="h-4 w-4" /></button>
          <div className="flex gap-1 rounded-lg border border-rule bg-surface p-1">
            <button onClick={() => setViewMode("posters")} title="Poster view" aria-label="Poster view" className={`rounded px-2 py-1.5 ${viewMode === "posters" ? "bg-accent text-accent-ink" : "text-ink-dim hover:bg-bg hover:text-ink"}`}><LayoutGrid className="h-4 w-4" /></button>
            <button onClick={() => setViewMode("table")} title="Table view" aria-label="Table view" className={`rounded px-2 py-1.5 ${viewMode === "table" ? "bg-accent text-accent-ink" : "text-ink-dim hover:bg-bg hover:text-ink"}`}><Rows3 className="h-4 w-4" /></button>
          </div>
          <button onClick={() => setSelecting((v) => { if (v) setSelected(new Set()); return !v; })} className="flex items-center gap-1.5 rounded-lg border border-rule bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-rule">
            <CheckSquare className="h-4 w-4" /> {selecting ? "Done" : "Select"}
          </button>
          <button onClick={() => setAddSearchOpen(true)} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90">
            <Plus className="h-4 w-4" /> Add movie
          </button>
        </div>
      </div>

      {selecting && selected.size > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-rule bg-surface px-3 py-2">
          <span className="text-sm text-ink">{selected.size} selected{movies.hasNextPage ? " of loaded titles" : ""}</span>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => setBulkEditOpen(true)} className="flex items-center gap-1.5 rounded-lg border border-rule bg-bg px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-ink hover:bg-rule"><Pencil className="h-3.5 w-3.5" /> Edit</button>
            <button onClick={() => setBulkTagsOpen(true)} className="flex items-center gap-1.5 rounded-lg border border-rule bg-bg px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-ink hover:bg-rule"><Tag className="h-3.5 w-3.5" /> Set Tags</button>
            <button onClick={() => bulkRename.mutate([...selected])} disabled={bulkRename.isPending} className="flex items-center gap-1.5 rounded-lg border border-rule bg-bg px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-ink hover:bg-rule disabled:opacity-50"><Wand2 className="h-3.5 w-3.5" /> Rename Files</button>
            <button onClick={() => setBulkDeleteOpen(true)} className="flex items-center gap-1.5 rounded-lg bg-err/10 px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-err hover:bg-err/20"><Trash2 className="h-3.5 w-3.5" /> Delete</button>
          </div>
        </div>
      )}

      {movies.isError ? <ErrorState error={movies.error} onRetry={() => movies.refetch()} /> : movies.isLoading ? (
        <p className="text-sm text-ink-dim">Loading…</p>
      ) : items.length === 0 ? (
        <EmptyState title="No movies yet" hint="Add a movie — the first release of the unified library." />
      ) : (
        <>
          {viewMode === "posters" ? (
            <>
              <div className={`grid gap-4 ${posterGridClass(posterSize)}`}>
                {items.map((m) => (
                  <MediaPosterCard
                    key={m.id}
                    id={m.id}
                    title={m.title}
                    year={m.releaseDate ? m.releaseDate.slice(0, 4) : null}
                    images={m.images}
                    monitored={m.monitored}
                    completeness={movieCompleteness(m)}
                    selecting={selecting}
                    selected={selected.has(m.id)}
                    onToggleSelect={toggle}
                    onClick={(id) => navigate(`/movies/${id}`)}
                    showTitle={showTitle}
                    qualityProfileName={showQualityProfile ? profileName(m.qualityProfileId) : null}
                  />
                ))}
              </div>
              <CompletenessLegend />
            </>
          ) : (
          <div className="overflow-hidden rounded-lg border border-rule">
            <table className="w-full text-left text-sm">
              <thead className="bg-bg text-[10px] font-semibold uppercase tracking-wide text-ink-dim">
                <tr>
                  {selecting && (
                    <th className="w-8 px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selected.size > 0 && selected.size === items.length}
                        onChange={(e) => setSelected(e.target.checked ? new Set(items.map((m) => m.id)) : new Set())}
                        title={movies.hasNextPage ? "Selects all currently loaded titles — Load more to select more" : "Select all"}
                        className="h-4 w-4"
                      />
                    </th>
                  )}
                  <th className="px-3 py-2">Title</th>
                  <th className="px-3 py-2">Year</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Monitored</th>
                  <th className="px-3 py-2 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {items.map((m) => (
                  <tr key={m.id} className="hover:bg-bg/60">
                    {selecting && <td className="px-3 py-2"><input type="checkbox" checked={selected.has(m.id)} onChange={() => toggle(m.id)} className="h-4 w-4" /></td>}
                    <td className="px-3 py-2 font-medium text-ink"><Link to={`/movies/${m.id}`} className="hover:text-accent">{m.title}</Link></td>
                    <td className="px-3 py-2 text-ink-dim">{m.releaseDate ? m.releaseDate.slice(0, 4) : "—"}</td>
                    <td className="px-3 py-2">
                      {movieCompleteness(m) ? <CompletenessBadge value={movieCompleteness(m)} /> : <span className="text-ink-dim">—</span>}
                    </td>
                    <td className="px-3 py-2"><Badge tone={m.monitored ? "ok" : "warn"}>{m.monitored ? "monitored" : "unmonitored"}</Badge></td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex justify-end gap-2">
                        <button onClick={() => meta.mutate(m.id)} title="Refresh from TMDB" className="rounded p-1 text-ink-dim hover:bg-rule hover:text-ink"><Database className="h-3.5 w-3.5" /></button>
                        <button onClick={() => remove.mutate(m.id)} className="text-xs text-err hover:underline">Remove</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
          {movies.hasNextPage && (
            <div className="flex justify-center pt-2">
              <button
                onClick={() => movies.fetchNextPage()}
                disabled={movies.isFetchingNextPage}
                className="rounded-lg border border-rule bg-surface px-4 py-1.5 text-sm font-medium text-ink hover:bg-rule disabled:opacity-50"
              >
                {movies.isFetchingNextPage ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </>
      )}

      {bulkMsg && <p className={`text-xs ${bulkMsgTone === "err" ? "text-err" : "text-ok"}`}>{bulkMsg}</p>}

      {addSearchOpen && <AddSearchModal mediaType="movie" onClose={() => setAddSearchOpen(false)} />}

      {bulkEditOpen && <BulkEditModal mediaType="movie" count={selected.size} onSave={(patch) => bulkEdit.mutate(patch)} onClose={() => setBulkEditOpen(false)} busy={bulkEdit.isPending} />}
      {bulkTagsOpen && <BulkTagsModal onSave={(tagIds, mode) => bulkTags.mutate({ tagIds, mode })} onClose={() => setBulkTagsOpen(false)} busy={bulkTags.isPending} />}
      {bulkDeleteOpen && <BulkDeleteModal mediaType="movie" names={selectedTitles} onConfirm={(opts) => bulkDelete.mutate(opts)} onClose={() => setBulkDeleteOpen(false)} busy={bulkDelete.isPending} />}
      {optionsOpen && <OptionsModal onClose={() => setOptionsOpen(false)} />}
    </div>
  );
}
