// SPDX-License-Identifier: MIT
// TagPicker — chip-based multi-select bound to the real tag catalog (GET /api/v1/tags,
// the same catalog the Settings > Tags tab maintains, roadmap P2 / gap C6). Stores tag
// *ids* (the stable key entity `tags` arrays reference), not labels. Selected tags render
// as removable chips; unselected catalog tags appear in a dropdown to add.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { api } from "../api/client";
import type { TagRow } from "../api/types";

const selectCls = "rounded-lg border border-rule bg-surface px-2 py-1 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

export function TagPicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const tags = useQuery({ queryKey: ["tags"], queryFn: () => api.get<TagRow[]>("/tags") });
  const [picked, setPicked] = useState("");

  const byId = useMemo(() => new Map((tags.data ?? []).map((t) => [t.id, t])), [tags.data]);
  const available = (tags.data ?? []).filter((t) => !value.includes(t.id));

  const remove = (id: string) => onChange(value.filter((v) => v !== id));
  const add = (id: string) => {
    if (!value.includes(id)) onChange([...value, id]);
    setPicked("");
  };

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((id) => {
            const tag = byId.get(id);
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium text-ink"
                style={tag?.color ? { backgroundColor: `color-mix(in_srgb, ${tag.color} 18%, transparent)` } : { backgroundColor: "var(--rule)" }}
              >
                {tag?.label ?? id}
                <button type="button" onClick={() => remove(id)} className="rounded p-0.5 text-ink-dim hover:text-err" aria-label={`Remove tag ${id}`}>
                  <X className="h-3 w-3" />
                </button>
              </span>
            );
          })}
        </div>
      )}
      {available.length > 0 && (
        <div className="flex items-center gap-1.5">
          <select value={picked} onChange={(e) => e.target.value && add(e.target.value)} className={selectCls} aria-label="Add tag">
            <option value="">Add tag…</option>
            {available.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
          <Plus className="h-3.5 w-3.5 text-ink-dim" />
        </div>
      )}
    </div>
  );
}
