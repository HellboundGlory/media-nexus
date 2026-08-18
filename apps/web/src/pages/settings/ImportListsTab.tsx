// SPDX-License-Identifier: MIT
// Settings > Import Lists (NAV-1 Phase 5, closes SON-026 + the Import-Lists half of UNI-016):
// real CRUD against apps/api/src/import-lists. Provider is "tmdb" today (config { listId }). A
// "Sync Now" per list triggers POST :id/grab. An exclusions sub-section (list/add/remove) uses
// createImportExclusionSchema.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, Pencil, Plus, RefreshCw } from "lucide-react";
import { api } from "../../api/client";
import type { ImportList, ImportExclusion } from "../../api/types";
import { Badge, EmptyState, ErrorState, formatDate } from "../../lib/ui";

const inputCls = "w-full rounded-lg border border-rule bg-transparent px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

export function ImportListsTab() {
  const qc = useQueryClient();
  const lists = useQuery({ queryKey: ["import-lists"], queryFn: () => api.get<ImportList[]>("/import-lists") });
  const exclusions = useQuery({ queryKey: ["import-exclusions"], queryFn: () => api.get<ImportExclusion[]>("/import-lists/exclusions") });
  const refetch = () => { qc.invalidateQueries({ queryKey: ["import-lists"] }); qc.invalidateQueries({ queryKey: ["import-exclusions"] }); };

  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", listId: "", enabled: true });

  const save = useMutation({
    mutationFn: async () => {
      if (editing) await api.put(`/import-lists/${editing}`, { name: form.name.trim(), enabled: form.enabled, config: { listId: form.listId.trim() } });
      else await api.post("/import-lists", { provider: "tmdb", name: form.name.trim(), enabled: form.enabled, config: { listId: form.listId.trim() } });
    },
    onSuccess: () => { refetch(); setEditing(null); setForm({ name: "", listId: "", enabled: true }); },
  });
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/import-lists/${id}`), onSuccess: refetch });
  const sync = useMutation({ mutationFn: (id: string) => api.post(`/import-lists/${id}/grab`), onSuccess: refetch });

  const [ex, setEx] = useState({ mediaType: "movie", externalId: "", reason: "" });
  const addExclusion = useMutation({
    mutationFn: () => api.post("/import-lists/exclusions", { mediaType: ex.mediaType, externalId: ex.externalId.trim(), reason: ex.reason.trim() || undefined }),
    onSuccess: () => { refetch(); setEx({ mediaType: "movie", externalId: "", reason: "" }); },
  });
  const removeExclusion = useMutation({ mutationFn: (id: string) => api.del(`/import-lists/exclusions/${id}`), onSuccess: refetch });

  const startEdit = (l: ImportList) => { setEditing(l.id); setForm({ name: l.name, listId: String(l.config?.listId ?? ""), enabled: l.enabled }); };
  const listRows = lists.data ?? [];
  const exclusionRows = exclusions.data ?? [];

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-rule bg-surface p-4">
        <h3 className="mb-3 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim">Import lists</h3>
        <div className="mb-3 grid gap-2 rounded-lg border border-rule bg-bg p-3 sm:grid-cols-4">
          <label className="block sm:col-span-2"><span className="mb-1 block text-xs text-ink-dim">Name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="My TMDB watchlist" className={inputCls} /></label>
          <label className="block"><span className="mb-1 block text-xs text-ink-dim">Provider</span><select disabled value="tmdb" className={inputCls}><option value="tmdb">TMDB</option></select></label>
          <label className="block"><span className="mb-1 block text-xs text-ink-dim">List id</span><input value={form.listId} onChange={(e) => setForm({ ...form, listId: e.target.value })} placeholder="e.g. /list/8238644" className={inputCls} /></label>
          <label className="flex items-center gap-2 text-sm text-ink-dim sm:col-span-2"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} className="h-4 w-4" /> Enabled</label>
          <div className="flex items-end gap-2 sm:col-span-2">
            <button onClick={() => save.mutate()} disabled={save.isPending || !form.name.trim() || !form.listId.trim()} className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50">{editing ? "Save" : "Add"}</button>
            {editing && <button onClick={() => { setEditing(null); setForm({ name: "", listId: "", enabled: true }); }} className="rounded-lg border border-rule bg-bg px-3 py-1.5 text-sm text-ink hover:bg-rule">Cancel</button>}
          </div>
        </div>
        {(save.isError || remove.isError || sync.isError) && <p className="mb-2 text-xs text-err">{((save.error ?? remove.error ?? sync.error) as Error)?.message ?? "Failed"}</p>}

        {lists.isError ? <ErrorState error={lists.error} onRetry={() => lists.refetch()} /> : listRows.length === 0 ? (
          <EmptyState title="No import lists" hint="Add a TMDB list above — monitored titles in it are imported and monitored automatically." />
        ) : (
          <div className="overflow-hidden rounded-lg border border-rule">
            <table className="w-full text-left text-sm">
              <thead className="bg-bg text-[10px] font-semibold uppercase tracking-wide text-ink-dim">
                <tr><th className="px-3 py-2">Name</th><th className="px-3 py-2">Provider</th><th className="px-3 py-2">Enabled</th><th className="px-3 py-2">Last sync</th><th className="px-3 py-2 text-right">Actions</th></tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {listRows.map((l) => (
                  <tr key={l.id} className="hover:bg-bg/60">
                    <td className="px-3 py-2 font-medium text-ink">{l.name}</td>
                    <td className="px-3 py-2"><Badge tone="neutral">{l.provider}</Badge></td>
                    <td className="px-3 py-2"><Badge tone={l.enabled ? "ok" : "warn"}>{l.enabled ? "enabled" : "disabled"}</Badge></td>
                    <td className="px-3 py-2 text-ink-dim">{l.lastSyncAt ? formatDate(l.lastSyncAt) : (l.lastError ? <span className="text-err">{l.lastError}</span> : "never")}</td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1">
                        <button onClick={() => sync.mutate(l.id)} disabled={sync.isPending} title="Sync now" className="rounded p-1 text-ink-dim hover:bg-rule hover:text-ink disabled:opacity-40"><RefreshCw className="h-4 w-4" /></button>
                        <button onClick={() => startEdit(l)} className="rounded p-1 text-ink-dim hover:bg-rule hover:text-ink" title="Edit"><Pencil className="h-4 w-4" /></button>
                        <button onClick={() => remove.mutate(l.id)} className="rounded p-1 text-ink-dim hover:bg-err-bg hover:text-err" title="Remove"><Trash2 className="h-4 w-4" /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-rule bg-surface p-4">
        <h3 className="mb-3 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim">Exclusions <span className="ml-1 text-[10px] text-ink-dim/70">(titles never re-added)</span></h3>
        <div className="mb-3 flex flex-wrap items-end gap-2 rounded-lg border border-rule bg-bg p-3">
          <select value={ex.mediaType} onChange={(e) => setEx({ ...ex, mediaType: e.target.value })} className={inputCls}>
            <option value="movie">Movie</option><option value="series">Series</option>
          </select>
          <input value={ex.externalId} onChange={(e) => setEx({ ...ex, externalId: e.target.value })} placeholder="External id (e.g. tmdbId)" className={`${inputCls} max-w-56`} />
          <input value={ex.reason} onChange={(e) => setEx({ ...ex, reason: e.target.value })} placeholder="Reason (optional)" className={`${inputCls} max-w-56`} />
          <button onClick={() => addExclusion.mutate()} disabled={addExclusion.isPending || !ex.externalId.trim()} className="inline-flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50"><Plus className="h-3.5 w-3.5" /> Add</button>
        </div>
        {addExclusion.isError && <p className="mb-2 text-xs text-err">{addExclusion.error instanceof Error ? addExclusion.error.message : "Failed"}</p>}
        {exclusions.isError ? <ErrorState error={exclusions.error} onRetry={() => exclusions.refetch()} /> : exclusionRows.length === 0 ? (
          <p className="text-sm text-ink-dim">No exclusions — removed titles are added automatically so they aren&apos;t re-imported. Add one to clear a title for re-adding.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-rule">
            <table className="w-full text-left text-sm">
              <thead className="bg-bg text-[10px] font-semibold uppercase tracking-wide text-ink-dim">
                <tr><th className="px-3 py-2">Type</th><th className="px-3 py-2">Title</th><th className="px-3 py-2">Reason</th><th className="px-3 py-2">Added</th><th className="px-3 py-2 text-right">Action</th></tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {exclusionRows.map((x) => (
                  <tr key={x.id} className="hover:bg-bg/60">
                    <td className="px-3 py-2"><Badge tone="neutral">{x.mediaType}</Badge></td>
                    <td className="px-3 py-2 text-ink">
                      {x.title ? (
                        <span className="font-medium">{x.title}{x.year ? <span className="text-ink-dim"> ({x.year})</span> : null}</span>
                      ) : (
                        <span className="font-mono text-xs text-ink">{x.externalId}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-ink-dim">{x.reason ?? "—"}</td>
                    <td className="px-3 py-2 text-ink-dim">{x.createdAt ? formatDate(x.createdAt) : "—"}</td>
                    <td className="px-3 py-2 text-right"><button onClick={() => removeExclusion.mutate(x.id)} className="rounded p-1 text-ink-dim hover:bg-err-bg hover:text-err" title="Remove exclusion"><Trash2 className="h-4 w-4" /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
