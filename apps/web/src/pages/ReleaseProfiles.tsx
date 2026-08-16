// SPDX-License-Identifier: MIT
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Filter, Trash2, Pencil } from "lucide-react";
import { api } from "../api/client";
import { Badge, ErrorState } from "../lib/ui";
import type { ReleaseProfile } from "../api/types";

const emptyForm = { name: "", enabled: true, required: "", ignored: "", tags: "" };

function splitLines(s: string): string[] {
  return s.split("\n").map((t) => t.trim()).filter(Boolean);
}
function splitTags(s: string): string[] {
  return s.split(",").map((t) => t.trim()).filter(Boolean);
}

export default function ReleaseProfiles() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);

  const profiles = useQuery({
    queryKey: ["release-profiles"],
    queryFn: () => api.get<ReleaseProfile[]>("/release-profiles"),
  });

  const refetch = () => qc.invalidateQueries({ queryKey: ["release-profiles"] });

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: form.name.trim(),
        enabled: form.enabled,
        required: splitLines(form.required),
        ignored: splitLines(form.ignored),
        tags: splitTags(form.tags),
      };
      if (editing) await api.put(`/release-profiles/${editing}`, body);
      else await api.post("/release-profiles", body);
    },
    onSuccess: () => { refetch(); setEditing(null); setForm(emptyForm); },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/release-profiles/${id}`),
    onSuccess: refetch,
  });

  const startEdit = (p: ReleaseProfile) => {
    setEditing(p.id);
    setForm({
      name: p.name,
      enabled: p.enabled,
      required: p.required.join("\n"),
      ignored: p.ignored.join("\n"),
      tags: p.tags.join(", "),
    });
  };

  const cancel = () => { setEditing(null); setForm(emptyForm); };

  const inputCls = "w-full rounded-lg border border-rule bg-transparent px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

  return (
    <div className="space-y-6">
      <div>
        <h2 className="flex items-center gap-2 font-display text-2xl font-bold uppercase tracking-[0.05em] text-ink">
          <Filter className="h-5 w-5" /> Release Profiles
        </h2>
        <p className="text-sm text-ink-dim">
          Tag-scoped hard restrictions for the decision engine. A release must contain at least one
          <code className="mx-1 rounded bg-neutral-bg px-1 text-ink">required</code> term and no
          <code className="mx-1 rounded bg-neutral-bg px-1 text-ink">ignored</code> term for each
          applicable profile. Terms are plain substrings or
          <code className="mx-1 rounded bg-neutral-bg px-1 text-ink">/regex/</code>. Profiles are reject-only;
          scored matching lives in Custom Formats.
        </p>
      </div>

      <div className="flex items-end gap-3 rounded-xl border border-rule bg-surface p-4">
        <label className="block grow">
          <span className="mb-1 block text-xs text-ink-dim">Required terms (one per line)</span>
          <input
            value={form.required}
            onChange={(e) => setForm({ ...form, required: e.target.value })}
            placeholder="x265, /1080p$/"
            className={inputCls}
          />
        </label>
        <label className="block grow">
          <span className="mb-1 block text-xs text-ink-dim">Ignored terms (one per line)</span>
          <input
            value={form.ignored}
            onChange={(e) => setForm({ ...form, ignored: e.target.value })}
            placeholder="/480p/, YIFY"
            className={inputCls}
          />
        </label>
        <label className="block w-56">
          <span className="mb-1 block text-xs text-ink-dim">Tags (comma-separated, empty = all)</span>
          <input
            value={form.tags}
            onChange={(e) => setForm({ ...form, tags: e.target.value })}
            placeholder="4k, original"
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-ink-dim">Enabled</span>
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            className="mt-2 h-4 w-4"
          />
        </label>
        <div className="flex gap-2">
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending || !form.name.trim()}
            className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50"
          >
            {editing ? "Save" : "Add"}
          </button>
          {editing && (
            <button onClick={cancel} className="rounded-lg border border-rule bg-surface px-3 py-1.5 text-sm text-ink hover:bg-rule">
              Cancel
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between">
        <label className="block">
          <span className="mb-1 block text-xs text-ink-dim">Name</span>
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="No hardsubbed releases"
            className={`${inputCls} w-72`}
          />
        </label>
        <span className="text-xs text-ink-dim">{profiles.data?.length ?? 0} profile(s)</span>
      </div>

      <section className="rounded-xl border border-rule bg-surface p-4">
        {profiles.isError && <ErrorState error={profiles.error} onRetry={() => profiles.refetch()} />}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-[10px] font-semibold uppercase tracking-wide text-ink-dim">
              <tr>
                <th className="pb-2 pr-3">Name</th>
                <th className="pb-2 pr-3">Status</th>
                <th className="pb-2 pr-3">Required</th>
                <th className="pb-2 pr-3">Ignored</th>
                <th className="pb-2 pr-3">Tags</th>
                <th className="pb-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {profiles.data?.map((p) => (
                <tr key={p.id}>
                  <td className="py-1.5 pr-3 font-medium text-ink">{p.name}</td>
                  <td className="py-1.5 pr-3"><Badge tone={p.enabled ? "ok" : "neutral"}>{p.enabled ? "enabled" : "disabled"}</Badge></td>
                  <td className="py-1.5 pr-3 font-mono text-xs text-ink-dim">{p.required.length ? p.required.join(", ") : <span className="text-ink-dim">—</span>}</td>
                  <td className="py-1.5 pr-3 font-mono text-xs text-ink-dim">{p.ignored.length ? p.ignored.join(", ") : <span className="text-ink-dim">—</span>}</td>
                  <td className="py-1.5 pr-3 text-xs text-ink-dim">{p.tags.length ? p.tags.join(", ") : <span className="text-ink-dim">all</span>}</td>
                  <td className="py-1.5 text-right">
                    <div className="inline-flex gap-1">
                      <button onClick={() => startEdit(p)} className="rounded p-1 text-ink-dim hover:bg-rule hover:text-ink" aria-label={`Edit ${p.name}`}>
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button onClick={() => remove.mutate(p.id)} className="rounded p-1 text-ink-dim hover:bg-err-bg hover:text-err" aria-label={`Delete ${p.name}`}>
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!profiles.isError && !profiles.data?.length && <p className="py-4 text-sm text-ink-dim">No release profiles yet — add one above.</p>}
        </div>
      </section>
    </div>
  );
}
