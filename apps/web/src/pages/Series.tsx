// SPDX-License-Identifier: MIT
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Search, Plus } from "lucide-react";
import { api } from "../api/client";
import type { Series as SeriesRow, Paged } from "../api/types";
import { Badge, EmptyState, ErrorState } from "../lib/ui";
import { AddTitleModal, type AddTitleBody } from "../components/AddTitleModal";

export default function Series() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ title: "", tvdbId: "" });
  // Holds the typed title until the AddTitleModal submits (QUALITYPROFILES-1): the quick-add's
  // purpose is to capture the identity, then the modal collects root folder / quality profile /
  // series type / tags before the actual POST /series.
  const [draft, setDraft] = useState<{ title: string; tvdbId?: number } | null>(null);

  const series = useQuery({
    queryKey: ["series", search],
    queryFn: () => api.get<Paged<SeriesRow>>(`/series?search=${encodeURIComponent(search)}`),
  });

  const add = useMutation({
    mutationFn: (vars: { title: string; tvdbId?: number; body: AddTitleBody }) =>
      api.post<SeriesRow>("/series", { title: vars.title, tvdbId: vars.tvdbId, ...vars.body }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["series"] }); setShowAdd(false); setForm({ title: "", tvdbId: "" }); setDraft(null); },
  });

  const remove = useMutation({ mutationFn: (id: string) => api.del(`/series/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["series"] }) });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl font-bold uppercase tracking-[0.05em] text-ink">Series</h2>
          <p className="text-sm text-ink-dim">{series.data?.total ?? 0} shows in library</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-ink-dim" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search shows…"
              className="w-56 rounded-lg border border-rule bg-surface px-3 py-1.5 pl-8 pr-3 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40" />
          </div>
          <button onClick={() => setShowAdd((v) => !v)} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90">
            <Plus className="h-4 w-4" /> Add series
          </button>
        </div>
      </div>

      {showAdd && (
        <form className="flex flex-wrap items-end gap-3 rounded-xl border border-rule bg-surface p-4"
          onSubmit={(e) => { e.preventDefault(); setDraft({ title: form.title, tvdbId: form.tvdbId ? Number(form.tvdbId) : undefined }); }}>
          <label className="flex-1 basis-52">
            <span className="mb-1 block text-xs text-ink-dim">Title</span>
            <input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })}
              className="w-full rounded-lg border border-rule bg-transparent px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40" />
          </label>
          <label className="basis-32">
            <span className="mb-1 block text-xs text-ink-dim">TVDB ID (optional)</span>
            <input value={form.tvdbId} onChange={(e) => setForm({ ...form, tvdbId: e.target.value })} type="number"
              className="w-full rounded-lg border border-rule bg-transparent px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40" />
          </label>
          <button type="submit" className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90">
            Continue
          </button>
        </form>
      )}

      {series.isError ? <ErrorState error={series.error} onRetry={() => series.refetch()} /> : series.isLoading ? (
        <p className="text-sm text-ink-dim">Loading…</p>
      ) : series.data && series.data.items.length === 0 ? (
        <EmptyState title="No series yet" hint="Add a show to start building the TV library." />
      ) : (
        <div className="overflow-hidden rounded-lg border border-rule">
          <table className="w-full text-left text-sm">
            <thead className="bg-bg text-[10px] font-semibold uppercase tracking-wide text-ink-dim">
              <tr><th className="px-3 py-2">Title</th><th className="px-3 py-2">Year</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Monitored</th><th className="px-3 py-2 text-right">Action</th></tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {series.data?.items.map((s) => (
                <tr key={s.id} className="hover:bg-bg/60">
                  <td className="px-3 py-2 font-medium text-ink"><Link to={`/series/${s.id}`} className="hover:text-accent">{s.title}</Link></td>
                  <td className="px-3 py-2 text-ink-dim">{s.firstAirYear ?? "—"}</td>
                  <td className="px-3 py-2"><Badge tone="neutral">{s.seriesType}</Badge></td>
                  <td className="px-3 py-2"><Badge tone={s.monitored ? "ok" : "warn"}>{s.monitored ? "monitored" : "unmonitored"}</Badge></td>
                  <td className="px-3 py-2 text-right"><button onClick={() => remove.mutate(s.id)} className="text-xs text-err hover:underline">Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {draft && (
        <AddTitleModal
          mediaType="series"
          title={draft.title}
          isPending={add.isPending}
          error={add.error}
          onClose={() => setDraft(null)}
          onSubmit={(body) => add.mutate({ title: draft.title, tvdbId: draft.tvdbId, body })}
        />
      )}
    </div>
  );
}
