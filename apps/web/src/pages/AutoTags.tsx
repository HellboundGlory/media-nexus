// SPDX-License-Identifier: MIT
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, Pencil, Plus } from "lucide-react";
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

  const inputCls = "rounded-lg border border-rule bg-transparent px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-rule bg-surface p-4">
        <div className="flex items-end gap-3">
          <label className="block grow">
            <span className="mb-1 block text-xs text-ink-dim">Rule name</span>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Genre: Comedy" className={`${inputCls} w-full`} />
          </label>
          <label className="block w-64">
            <span className="mb-1 block text-xs text-ink-dim">Managed tags (comma-separated ids)</span>
            <input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="comedy-tag, favorite" className={`${inputCls} w-full`} />
          </label>
          <label className="flex items-center gap-2 pb-1.5 text-sm text-ink-dim">
            <input type="checkbox" checked={form.removeTagsAutomatically} onChange={(e) => setForm({ ...form, removeTagsAutomatically: e.target.checked })} className="h-4 w-4" />
            Remove tags when unmatched
          </label>
        </div>

        <div className="mt-3 space-y-2">
          <span className="text-xs text-ink-dim">Conditions (rule matches when every type-group matches)</span>
          {form.specifications.map((s, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-rule p-2">
              <select value={s.type} onChange={(e) => { const nt = e.target.value; setRow(i, { type: nt, value: nt === "monitored" ? true : "" }); }} className={inputCls}>
                {SPEC_TYPES.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
              </select>
              {s.type === "monitored" ? (
                <label className="flex items-center gap-2 text-sm text-ink-dim">
                  <input type="checkbox" checked={Boolean(s.value)} onChange={(e) => setRow(i, { value: e.target.checked })} className="h-4 w-4" /> monitored
                </label>
              ) : s.type === "year" ? (
                <input type="number" value={Number(s.value)} onChange={(e) => setRow(i, { value: Number(e.target.value) })} className={`${inputCls} w-28`} />
              ) : (
                <input value={String(s.value)} onChange={(e) => setRow(i, { value: e.target.value })} placeholder="value" className={`${inputCls} w-40`} />
              )}
              <label className="flex items-center gap-1 text-xs text-ink-dim"><input type="checkbox" checked={s.negate} onChange={(e) => setRow(i, { negate: e.target.checked })} className="h-3.5 w-3.5" /> negate</label>
              <label className="flex items-center gap-1 text-xs text-ink-dim"><input type="checkbox" checked={s.required} onChange={(e) => setRow(i, { required: e.target.checked })} className="h-3.5 w-3.5" /> required</label>
              <button onClick={() => setForm((f) => ({ ...f, specifications: f.specifications.filter((_, j) => j !== i) }))} className="rounded p-1 text-ink-dim hover:text-err" aria-label="Remove spec"><Trash2 className="h-4 w-4" /></button>
            </div>
          ))}
          <button onClick={() => setForm((f) => ({ ...f, specifications: [...f.specifications, emptySpec()] }))} className="inline-flex items-center gap-1.5 rounded-lg border border-rule bg-surface px-3 py-1.5 text-sm text-ink-dim hover:bg-rule hover:text-ink">
            <Plus className="h-3.5 w-3.5" /> Add condition
          </button>
        </div>

        <div className="mt-4 flex gap-2">
          <button onClick={() => save.mutate()} disabled={save.isPending || !form.name.trim()} className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50">
            {editing ? "Save" : "Add rule"}
          </button>
          {editing && <button onClick={cancel} className="rounded-lg border border-rule bg-surface px-3 py-1.5 text-sm text-ink hover:bg-rule">Cancel</button>}
        </div>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-dim">{rules.data?.length ?? 0} rule(s)</p>
      </div>

      <section className="rounded-xl border border-rule bg-surface p-4">
        {rules.isError && <ErrorState error={rules.error} onRetry={() => rules.refetch()} />}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-[10px] font-semibold uppercase tracking-wide text-ink-dim">
              <tr>
                <th className="pb-2 pr-3">Name</th>
                <th className="pb-2 pr-3">Conditions</th>
                <th className="pb-2 pr-3">Tags</th>
                <th className="pb-2 pr-3">Remove when unmatched</th>
                <th className="pb-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {rules.data?.map((r) => (
                <tr key={r.id}>
                  <td className="py-1.5 pr-3 font-medium text-ink">{r.name}</td>
                  <td className="py-1.5 pr-3 font-mono text-xs text-ink-dim">{r.specifications.length ? r.specifications.map(specText).join(" , ") : <span className="text-ink-dim">—</span>}</td>
                  <td className="py-1.5 pr-3 text-xs text-ink-dim">{r.tags.length ? r.tags.join(", ") : <span className="text-ink-dim">—</span>}</td>
                  <td className="py-1.5 pr-3"><Badge tone={r.removeTagsAutomatically ? "warn" : "neutral"}>{r.removeTagsAutomatically ? "yes" : "no"}</Badge></td>
                  <td className="py-1.5 text-right">
                    <div className="inline-flex gap-1">
                      <button onClick={() => startEdit(r)} className="rounded p-1 text-ink-dim hover:bg-rule hover:text-ink" aria-label={`Edit ${r.name}`}><Pencil className="h-4 w-4" /></button>
                      <button onClick={() => remove.mutate(r.id)} className="rounded p-1 text-ink-dim hover:bg-err-bg hover:text-err" aria-label={`Delete ${r.name}`}><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rules.isError && !rules.data?.length && <p className="py-4 text-sm text-ink-dim">No auto-tag rules yet — add one above.</p>}
        </div>
      </section>
    </div>
  );
}
