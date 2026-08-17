// SPDX-License-Identifier: MIT
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { CheckSquare, Search, Plus, Database, Pencil, Tag, Trash2 } from "lucide-react";
import { api } from "../api/client";
import type { Movie, Paged } from "../api/types";
import { Badge, EmptyState, ErrorState } from "../lib/ui";
import { AddTitleModal, type AddTitleBody } from "../components/AddTitleModal";
import { BulkEditModal, type BulkEditPatch } from "../components/BulkEditModal";
import { BulkTagsModal } from "../components/BulkTagsModal";
import { BulkDeleteModal, type BulkDeleteOptions } from "../components/BulkDeleteModal";

interface BulkResult {
  updated: string[];
  failed: { id: string; error: string }[];
}

export default function Movies() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ title: "", tmdbId: "" });
  const [draft, setDraft] = useState<{ title: string; tmdbId?: number } | null>(null);

  // ---- bulk selection (UNI-020) ----
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [bulkTagsOpen, setBulkTagsOpen] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);

  const movies = useQuery({
    queryKey: ["movies", search],
    queryFn: () => api.get<Paged<Movie>>(`/movies?search=${encodeURIComponent(search)}`),
  });
  const items = movies.data?.items ?? [];

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
    setBulkMsg(res.failed.length > 0 ? `${res.failed.length} item(s) failed: ${res.failed[0].error}` : null);
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

  const add = useMutation({
    mutationFn: (vars: { title: string; tmdbId?: number; body: AddTitleBody }) =>
      api.post<Movie>("/movies", { title: vars.title, tmdbId: vars.tmdbId, ...vars.body }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["movies"] }); setShowAdd(false); setForm({ title: "", tmdbId: "" }); setDraft(null); },
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
          <p className="text-sm text-ink-dim">{movies.data?.total ?? 0} titles in library</p>
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
          <button onClick={() => setSelecting((v) => { if (v) setSelected(new Set()); return !v; })} className="flex items-center gap-1.5 rounded-lg border border-rule bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-rule">
            <CheckSquare className="h-4 w-4" /> {selecting ? "Done" : "Select"}
          </button>
          <button onClick={() => setShowAdd((v) => !v)} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90">
            <Plus className="h-4 w-4" /> Add movie
          </button>
        </div>
      </div>

      {selecting && selected.size > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-rule bg-surface px-3 py-2">
          <span className="text-sm text-ink">{selected.size} selected</span>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => setBulkEditOpen(true)} className="flex items-center gap-1.5 rounded-lg border border-rule bg-bg px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-ink hover:bg-rule"><Pencil className="h-3.5 w-3.5" /> Edit</button>
            <button onClick={() => setBulkTagsOpen(true)} className="flex items-center gap-1.5 rounded-lg border border-rule bg-bg px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-ink hover:bg-rule"><Tag className="h-3.5 w-3.5" /> Set Tags</button>
            <button onClick={() => setBulkDeleteOpen(true)} className="flex items-center gap-1.5 rounded-lg bg-err/10 px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-err hover:bg-err/20"><Trash2 className="h-3.5 w-3.5" /> Delete</button>
          </div>
        </div>
      )}

      {showAdd && (
        <form
          className="flex flex-wrap items-end gap-3 rounded-xl border border-rule bg-surface p-4"
          onSubmit={(e) => { e.preventDefault(); setDraft({ title: form.title, tmdbId: form.tmdbId ? Number(form.tmdbId) : undefined }); }}
        >
          <label className="flex-1 basis-52">
            <span className="mb-1 block text-xs text-ink-dim">Title</span>
            <input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })}
              className="w-full rounded-lg border border-rule bg-transparent px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40" />
          </label>
          <label className="basis-32">
            <span className="mb-1 block text-xs text-ink-dim">TMDB ID (optional)</span>
            <input value={form.tmdbId} onChange={(e) => setForm({ ...form, tmdbId: e.target.value })} type="number"
              className="w-full rounded-lg border border-rule bg-transparent px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40" />
          </label>
          <button type="submit" className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90">
            Continue
          </button>
        </form>
      )}

      {movies.isError ? <ErrorState error={movies.error} onRetry={() => movies.refetch()} /> : movies.isLoading ? (
        <p className="text-sm text-ink-dim">Loading…</p>
      ) : items.length === 0 ? (
        <EmptyState title="No movies yet" hint="Add a movie — the first release of the unified library." />
      ) : (
        <div className="overflow-hidden rounded-lg border border-rule">
          <table className="w-full text-left text-sm">
            <thead className="bg-bg text-[10px] font-semibold uppercase tracking-wide text-ink-dim">
              <tr>
                {selecting && (
                  <th className="w-8 px-3 py-2"><input type="checkbox" checked={selected.size > 0 && selected.size === items.length} onChange={(e) => setSelected(e.target.checked ? new Set(items.map((m) => m.id)) : new Set())} className="h-4 w-4" /></th>
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
                  <td className="px-3 py-2"><Badge tone="neutral">{m.status}</Badge></td>
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

      {bulkMsg && <p className="text-xs text-err">{bulkMsg}</p>}

      {draft && (
        <AddTitleModal
          mediaType="movie"
          title={draft.title}
          isPending={add.isPending}
          error={add.error}
          onClose={() => setDraft(null)}
          onSubmit={(body) => add.mutate({ title: draft.title, tmdbId: draft.tmdbId, body })}
        />
      )}

      {bulkEditOpen && <BulkEditModal mediaType="movie" count={selected.size} onSave={(patch) => bulkEdit.mutate(patch)} onClose={() => setBulkEditOpen(false)} busy={bulkEdit.isPending} />}
      {bulkTagsOpen && <BulkTagsModal onSave={(tagIds, mode) => bulkTags.mutate({ tagIds, mode })} onClose={() => setBulkTagsOpen(false)} busy={bulkTags.isPending} />}
      {bulkDeleteOpen && <BulkDeleteModal mediaType="movie" names={selectedTitles} onConfirm={(opts) => bulkDelete.mutate(opts)} onClose={() => setBulkDeleteOpen(false)} busy={bulkDelete.isPending} />}
    </div>
  );
}
