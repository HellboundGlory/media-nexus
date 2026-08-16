// SPDX-License-Identifier: MIT
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Search, Plus, Database } from "lucide-react";
import { api } from "../api/client";
import type { Movie, Paged } from "../api/types";
import { Badge, EmptyState, ErrorState } from "../lib/ui";

export default function Movies() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ title: "", tmdbId: "" });

  const movies = useQuery({
    queryKey: ["movies", search],
    queryFn: () => api.get<Paged<Movie>>(`/movies?search=${encodeURIComponent(search)}`),
  });

  const add = useMutation({
    mutationFn: (body: { title: string; tmdbId?: number }) => api.post<Movie>("/movies", body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["movies"] }); setShowAdd(false); setForm({ title: "", tmdbId: "" }); },
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
          <h2 className="text-2xl font-semibold tracking-tight">Movies</h2>
          <p className="text-sm text-zinc-500">{movies.data?.total ?? 0} titles in library</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-zinc-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search titles…"
              className="w-56 rounded-lg border border-zinc-300 bg-white py-1.5 pl-8 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </div>
          <button onClick={() => setShowAdd((v) => !v)} className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-500">
            <Plus className="h-4 w-4" /> Add movie
          </button>
        </div>
      </div>

      {showAdd && (
        <form
          className="flex flex-wrap items-end gap-3 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
          onSubmit={(e) => { e.preventDefault(); add.mutate({ title: form.title, tmdbId: form.tmdbId ? Number(form.tmdbId) : undefined }); }}
        >
          <label className="flex-1 basis-52">
            <span className="mb-1 block text-xs text-zinc-500">Title</span>
            <input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })}
              className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-zinc-700" />
          </label>
          <label className="basis-32">
            <span className="mb-1 block text-xs text-zinc-500">TMDB ID (optional)</span>
            <input value={form.tmdbId} onChange={(e) => setForm({ ...form, tmdbId: e.target.value })} type="number"
              className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-zinc-700" />
          </label>
          <button disabled={add.isPending} className="rounded-lg bg-violet-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">
            {add.isPending ? "Adding…" : "Add"}
          </button>
          {add.isError && <p className="text-xs text-red-600">{add.error instanceof Error ? add.error.message : "Failed"}</p>}
        </form>
      )}

      {movies.isError ? <ErrorState error={movies.error} onRetry={() => movies.refetch()} /> : movies.isLoading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : movies.data && movies.data.items.length === 0 ? (
        <EmptyState title="No movies yet" hint="Add a movie — the first release of the unified library." />
      ) : (
        <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-zinc-50 text-xs uppercase text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
              <tr>
                <th className="px-4 py-2.5">Title</th>
                <th className="px-4 py-2.5">Year</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Monitored</th>
                <th className="px-4 py-2.5 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {movies.data?.items.map((m) => (
                <tr key={m.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-900/60">
                  <td className="px-4 py-2.5 font-medium"><Link to={`/movies/${m.id}`} className="hover:text-accent">{m.title}</Link></td>
                  <td className="px-4 py-2.5 text-zinc-500">{m.releaseDate ? m.releaseDate.slice(0, 4) : "—"}</td>
                  <td className="px-4 py-2.5"><Badge tone="neutral">{m.status}</Badge></td>
                  <td className="px-4 py-2.5"><Badge tone={m.hasFile ? "ok" : "warn"}>{m.hasFile ? "available" : "missing"}</Badge></td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex justify-end gap-2">
                      <button onClick={() => meta.mutate(m.id)} title="Refresh from TMDB" className="rounded p-1 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"><Database className="h-3.5 w-3.5" /></button>
                      <button onClick={() => remove.mutate(m.id)} className="text-xs text-red-500 hover:underline">Remove</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
