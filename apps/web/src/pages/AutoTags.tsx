// SPDX-License-Identifier: MIT
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Tags, Trash2, Pencil, Plus } from "lucide-react";
import { api } from "../api/client";
import { Badge, ErrorState } from "../lib/ui";
import type { AutoTag, AutoTagSpec } from "../api/types";

const SPEC_TYPES: { type: string; label: string }[] = [
  { type: "tag", label: "Has tag" },
  { type: "year", label: "Year" },
  { type: "genre", label: "Genre" },
  { type: "status", label: "Status" },
  { type: "monitored", label: "Monitored" },
  { type: "rootFolder", label: "Root folder" },
  { type: "qualityProfile", label: "Quality profile" },
  { type: "network", label: "Network (series)" },
  { type: "seriesType", label: "Series type (series)" },
];

interface SpecRow { type: string; value: string | number | boolean; negate: boolean; required: boolean }

const emptySpec = (): SpecRow => ({ type: "genre", value: "", negate: false, required: false });
const emptyForm = { name: "", removeTagsAutomatically: false, tags: "", specifications: [emptySpec()] as SpecRow[] };

function specText(s: AutoTagSpec): string {
  const neg = s.negate ? "!" : "";
  return `${neg}${s.type}: ${String(s.value)}${s.required ? " [req]" : ""}`;
}

export default function AutoTags() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);

  const rules = useQuery({ queryKey: ["auto-tags"], queryFn: () => api.get<AutoTag[]>("/auto-tags") });
  const refetch = () => qc.invalidateQueries({ queryKey: ["auto-tags"] });

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: form.name.trim(),
        removeTagsAutomatically: form.removeTagsAutomatically,
        tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean),
        specifications: form.specifications.map((s) => ({
          type: s.type,
          value: s.type === "year" ? Number(s.value) : s.value,
          negate: s.negate,
          required: s.required,
        })),
      };
      if (editing) await api.put(`/auto-tags/${editing}`, body);
      else await api.post("/auto-tags", body);
    },
    onSuccess: () => { refetch(); setEditing(null); setForm(emptyForm); },
  });

  const remove = useMutation({ mutationFn: (id: string) => api.del(`/auto-tags/${id}`), onSuccess: refetch });

  const startEdit = (r: AutoTag) => {
    setEditing(r.id);
    setForm({
      name: r.name,
      removeTagsAutomatically: r.removeTagsAutomatically,
      tags: r.tags.join(", "),
      specifications: r.specifications.map((s) => ({ type: s.type, value: s.value, negate: s.negate, required: s.required })),
    });
  };
  const cancel = () => { setEditing(null); setForm(emptyForm); };

  const setRow = (i: number, patch: Partial<SpecRow>) => {
    setForm((f) => ({ ...f, specifications: f.specifications.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  };

  const inputCls = "rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-zinc-700";

  return (
    <div className="space-y-6">
      <div>
        <h2 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Tags className="h-5 w-5" /> Auto Tags
        </h2>
        <p className="text-sm text-zinc-500">
          Rules that automatically add (or, when enabled, remove) tags on movies/series that match their
          conditions. A rule matches when <em>every</em> condition type-group passes; specify tags these
          rules manage as comma-separated tag ids. Applies on create, edit, and metadata refresh.
        </p>
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-end gap-3">
          <label className="block grow">
            <span className="mb-1 block text-xs text-zinc-500">Rule name</span>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Genre: Comedy" className={`${inputCls} w-full`} />
          </label>
          <label className="block w-64">
            <span className="mb-1 block text-xs text-zinc-500">Managed tags (comma-separated ids)</span>
            <input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="comedy-tag, favorite" className={`${inputCls} w-full`} />
          </label>
          <label className="flex items-center gap-2 pb-1.5 text-sm text-zinc-600 dark:text-zinc-300">
            <input type="checkbox" checked={form.removeTagsAutomatically} onChange={(e) => setForm({ ...form, removeTagsAutomatically: e.target.checked })} className="h-4 w-4" />
            Remove tags when unmatched
          </label>
        </div>

        <div className="mt-3 space-y-2">
          <span className="text-xs text-zinc-500">Conditions (rule matches when every type-group matches)</span>
          {form.specifications.map((s, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
              <select value={s.type} onChange={(e) => { const nt = e.target.value; setRow(i, { type: nt, value: nt === "monitored" ? true : "" }); }} className={inputCls}>
                {SPEC_TYPES.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
              </select>
              {s.type === "monitored" ? (
                <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-300">
                  <input type="checkbox" checked={Boolean(s.value)} onChange={(e) => setRow(i, { value: e.target.checked })} className="h-4 w-4" /> monitored
                </label>
              ) : s.type === "year" ? (
                <input type="number" value={Number(s.value)} onChange={(e) => setRow(i, { value: Number(e.target.value) })} className={`${inputCls} w-28`} />
              ) : (
                <input value={String(s.value)} onChange={(e) => setRow(i, { value: e.target.value })} placeholder="value" className={`${inputCls} w-40`} />
              )}
              <label className="flex items-center gap-1 text-xs text-zinc-500"><input type="checkbox" checked={s.negate} onChange={(e) => setRow(i, { negate: e.target.checked })} className="h-3.5 w-3.5" /> negate</label>
              <label className="flex items-center gap-1 text-xs text-zinc-500"><input type="checkbox" checked={s.required} onChange={(e) => setRow(i, { required: e.target.checked })} className="h-3.5 w-3.5" /> required</label>
              <button onClick={() => setForm((f) => ({ ...f, specifications: f.specifications.filter((_, j) => j !== i) }))} className="rounded p-1 text-zinc-400 hover:text-red-600" aria-label="Remove spec"><Trash2 className="h-4 w-4" /></button>
            </div>
          ))}
          <button onClick={() => setForm((f) => ({ ...f, specifications: [...f.specifications, emptySpec()] }))} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">
            <Plus className="h-3.5 w-3.5" /> Add condition
          </button>
        </div>

        <div className="mt-4 flex gap-2">
          <button onClick={() => save.mutate()} disabled={save.isPending || !form.name.trim()} className="rounded-lg bg-violet-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">
            {editing ? "Save" : "Add rule"}
          </button>
          {editing && <button onClick={cancel} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800">Cancel</button>}
        </div>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-500">{rules.data?.length ?? 0} rule(s)</p>
      </div>

      <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        {rules.isError && <ErrorState error={rules.error} onRetry={() => rules.refetch()} />}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-zinc-500 dark:text-zinc-400">
              <tr>
                <th className="pb-2 pr-3">Name</th>
                <th className="pb-2 pr-3">Conditions</th>
                <th className="pb-2 pr-3">Tags</th>
                <th className="pb-2 pr-3">Remove when unmatched</th>
                <th className="pb-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {rules.data?.map((r) => (
                <tr key={r.id}>
                  <td className="py-1.5 pr-3 font-medium">{r.name}</td>
                  <td className="py-1.5 pr-3 font-mono text-xs text-zinc-600 dark:text-zinc-300">{r.specifications.length ? r.specifications.map(specText).join(" , ") : <span className="text-zinc-400">—</span>}</td>
                  <td className="py-1.5 pr-3 text-xs text-zinc-600 dark:text-zinc-300">{r.tags.length ? r.tags.join(", ") : <span className="text-zinc-400">—</span>}</td>
                  <td className="py-1.5 pr-3"><Badge tone={r.removeTagsAutomatically ? "warn" : "neutral"}>{r.removeTagsAutomatically ? "yes" : "no"}</Badge></td>
                  <td className="py-1.5 text-right">
                    <div className="inline-flex gap-1">
                      <button onClick={() => startEdit(r)} className="rounded p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-100" aria-label={`Edit ${r.name}`}><Pencil className="h-4 w-4" /></button>
                      <button onClick={() => remove.mutate(r.id)} className="rounded p-1 text-zinc-500 hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-900/30" aria-label={`Delete ${r.name}`}><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rules.isError && !rules.data?.length && <p className="py-4 text-sm text-zinc-500">No auto-tag rules yet — add one above.</p>}
        </div>
      </section>
    </div>
  );
}
