// SPDX-License-Identifier: MIT
// Settings — the tabbed admin destination (NAV-1 Phase 3). 13 tabs matching upstream's real
// Settings list. Phase 3 wires the six relocation-safe tabs (Profiles, Quality, Custom Formats,
// Indexers, Download Clients, Tags) by reusing each existing component with only its page header
// stripped; the rest render an honest "not built" stub until Phases 4/5 flip them real. Tab
// selection is local component state (same Tab pattern as Activity), not URL-backed routes.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, Pencil } from "lucide-react";
import { api } from "../api/client";
import type { TagRow, QualityDefinitionRow } from "../api/types";
import { Badge, ErrorState, EmptyState } from "../lib/ui";
import QualityProfiles from "./QualityProfiles";
import ReleaseProfiles from "./ReleaseProfiles";
import AutoTags from "./AutoTags";
import CustomFormats from "./CustomFormats";
import Indexers from "./Indexers";
import Clients from "./Clients";
import { ConnectTab } from "./settings/ConnectTab";
import { MetadataSourceTab } from "./settings/MetadataSourceTab";
import { GeneralTab } from "./settings/GeneralTab";
import { UITab } from "./settings/UITab";
import { ImportListsTab } from "./settings/ImportListsTab";
import { MediaManagementTab } from "./settings/MediaManagementTab";

type TabId = "media" | "profiles" | "quality" | "formats" | "indexers" | "clients" | "importlists" | "connect" | "metadata" | "metadatasource" | "tags" | "general" | "ui";

const TABS: { id: TabId; label: string; future?: boolean }[] = [
  { id: "media", label: "Media Management" },
  { id: "profiles", label: "Profiles" },
  { id: "quality", label: "Quality" },
  { id: "formats", label: "Custom Formats" },
  { id: "indexers", label: "Indexers" },
  { id: "clients", label: "Download Clients" },
  { id: "importlists", label: "Import Lists" },
  { id: "connect", label: "Connect" },
  { id: "metadata", label: "Metadata" },
  { id: "metadatasource", label: "Metadata Source" },
  { id: "tags", label: "Tags" },
  { id: "general", label: "General" },
  { id: "ui", label: "UI" },
];

const REAL: ReadonlySet<TabId> = new Set(["media", "profiles", "quality", "formats", "indexers", "clients", "importlists", "connect", "metadatasource", "tags", "general", "ui"]);

const inputCls = "rounded-lg border border-rule bg-transparent px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

export default function Settings() {
  const [tab, setTab] = useState<TabId>("profiles");

  const isReal = REAL.has(tab);
  const active = TABS.find((t) => t.id === tab)!;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-display text-2xl font-bold uppercase tracking-[0.05em] text-ink">Settings</h2>
        <p className="text-sm text-ink-dim">Configuration — quality, formats, providers, and behavior.</p>
      </div>

      <div className="flex flex-wrap gap-1 rounded-lg border border-rule bg-surface p-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-md px-3 py-1.5 text-sm font-display font-semibold uppercase tracking-wide transition-colors ${tab === t.id ? "bg-accent text-accent-ink" : `text-ink-dim hover:bg-bg hover:text-ink ${t.future ? "border border-dashed border-rule" : ""}`}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {!isReal && <FutureStub label={active.label} />}

      {tab === "profiles" && (
        <div className="space-y-8">
          <QualityProfiles />
          <div>
            <h3 className="mb-2 flex items-center gap-2 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim">Delay Profiles <Badge tone="neutral">not built yet</Badge></h3>
            <div className="rounded-xl border border-dashed border-rule bg-surface p-6 text-center text-sm text-ink-dim">Delay Profiles aren&apos;t implemented (no backend). Shown so the tab reflects the real target list.</div>
          </div>
          <ReleaseProfiles />
        </div>
      )}

      {tab === "quality" && <QualityDefinitionsTab />}

      {tab === "formats" && <CustomFormats />}
      {tab === "indexers" && <Indexers />}
      {tab === "clients" && <Clients />}

      {tab === "tags" && (
        <div className="space-y-8">
          <TagCatalog />
          <AutoTags />
        </div>
      )}

      {tab === "connect" && <ConnectTab />}
      {tab === "metadatasource" && <MetadataSourceTab />}
      {tab === "general" && <GeneralTab />}
      {tab === "ui" && <UITab />}
      {tab === "media" && <MediaManagementTab />}
      {tab === "importlists" && <ImportListsTab />}
    </div>
  );
}

/** Honest not-built stub — never implies a feature exists. */
function FutureStub({ label }: { label: string }) {
  return (
    <div className="rounded-xl border border-dashed border-rule bg-surface p-6 text-center text-sm text-ink-dim">
      This sub-page isn&apos;t built yet (<b className="text-ink">{label}</b>) — shown only so the tab bar reflects the real target list, not to imply it&apos;s ready.
    </div>
  );
}

/** Quality tab: read-only per-quality size definitions (GET /quality-definitions). No editing —
 *  there is no PUT endpoint (intentionally out of scope). */
function QualityDefinitionsTab() {
  const defs = useQuery({ queryKey: ["quality-definitions"], queryFn: () => api.get<QualityDefinitionRow[]>("/quality-definitions") });
  const rows = defs.data ?? [];
  return (
    <div className="space-y-2">
      {defs.isError ? <ErrorState error={defs.error} onRetry={() => defs.refetch()} /> : rows.length === 0 ? (
        <EmptyState title="No quality definitions" />
      ) : (
        <div className="overflow-hidden rounded-lg border border-rule">
          <table className="w-full text-left text-sm">
            <thead className="bg-bg text-[10px] font-semibold uppercase tracking-wide text-ink-dim">
              <tr><th className="px-3 py-2">Quality</th><th className="px-3 py-2">Min size (MB/min)</th><th className="px-3 py-2">Max size (MB/min)</th><th className="px-3 py-2">Preferred (MB/min)</th></tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {rows.map((d) => (
                <tr key={d.id}>
                  <td className="px-3 py-2 font-medium text-ink">{d.title}</td>
                  <td className="px-3 py-2 text-ink-dim">{d.minSize ?? "—"}</td>
                  <td className="px-3 py-2 text-ink-dim">{d.maxSize ?? "—"}</td>
                  <td className="px-3 py-2 text-ink-dim">{d.preferredSize ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Tags tab top half: real tag-catalog CRUD (GET/POST/PUT/DELETE /api/v1/tags) — closes the
 *  "no catalog UI" half of UNI-017. The deeper half (release-profile/auto-tag forms binding raw
 *  free-text ids) is out of scope for NAV-1. Auto Tags renders below. */
function TagCatalog() {
  const qc = useQueryClient();
  const tags = useQuery({ queryKey: ["tags"], queryFn: () => api.get<TagRow[]>("/tags") });
  const [editing, setEditing] = useState<string | null>(null);
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [color, setColor] = useState("#2f6fb0");

  const reset = () => { setEditing(null); setId(""); setLabel(""); setColor("#2f6fb0"); };
  const refetch = () => qc.invalidateQueries({ queryKey: ["tags"] });

  const save = useMutation({
    mutationFn: async () => {
      if (editing) await api.put(`/tags/${editing}`, { label: label.trim() || undefined, color });
      else await api.post("/tags", { id: id.trim(), label: label.trim() || undefined, color });
    },
    onSuccess: () => { refetch(); reset(); },
  });

  const remove = useMutation({ mutationFn: (tagId: string) => api.del(`/tags/${tagId}`), onSuccess: refetch });

  const startEdit = (t: TagRow) => {
    setEditing(t.id); setId(t.id); setLabel(t.label); setColor(t.color ?? "#2f6fb0");
  };

  const rows = tags.data ?? [];

  return (
    <div className="space-y-3">
      <h3 className="font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim">Tag Catalog</h3>
      <p className="text-xs text-ink-dim">Stable ids referenced by movies, series, indexers and download clients for tag-based routing. Deleting a tag strips it from everything that used it.</p>

      <div className="flex flex-wrap items-end gap-2 rounded-xl border border-rule bg-surface p-3">
        {!editing && (
          <label className="min-w-32">
            <span className="mb-1 block text-xs text-ink-dim">Id (slug)</span>
            <input value={id} onChange={(e) => setId(e.target.value)} placeholder="favorite" className={`${inputCls} w-full`} />
          </label>
        )}
        <label className="min-w-40">
          <span className="mb-1 block text-xs text-ink-dim">Label</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Favorites" className={`${inputCls} w-full`} />
        </label>
        <label className="flex items-center gap-2 pb-1 text-xs text-ink-dim">
          Color
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-8 w-10 rounded border border-rule bg-transparent" />
        </label>
        <div className="flex items-center gap-2">
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending || !id.trim() || !label.trim()}
            className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50"
          >
            {editing ? "Save" : "Add"}
          </button>
          {editing && <button onClick={reset} className="rounded-lg border border-rule bg-bg px-3 py-1.5 text-sm text-ink hover:bg-rule">Cancel</button>}
        </div>
        {(save.isError || remove.isError) && <p className="w-full text-xs text-err">{((save.error ?? remove.error) as Error)?.message ?? "Failed"}</p>}
      </div>

      {tags.isError ? <ErrorState error={tags.error} onRetry={() => tags.refetch()} /> : rows.length === 0 ? (
        <EmptyState title="No tags yet" hint="Add one above — tags let you scope indexers/download clients to specific media." />
      ) : (
        <div className="overflow-hidden rounded-lg border border-rule">
          <table className="w-full text-left text-sm">
            <thead className="bg-bg text-[10px] font-semibold uppercase tracking-wide text-ink-dim">
              <tr><th className="px-3 py-2">Id</th><th className="px-3 py-2">Label</th><th className="px-3 py-2">Color</th><th className="px-3 py-2 text-right">Actions</th></tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {rows.map((t) => (
                <tr key={t.id} className="hover:bg-bg/60">
                  <td className="px-3 py-2 font-mono text-xs text-ink">{t.id}</td>
                  <td className="px-3 py-2 font-medium text-ink">{t.label}</td>
                  <td className="px-3 py-2"><span className="inline-flex items-center gap-1.5 text-xs text-ink-dim"><span className="h-3 w-3 rounded-full" style={{ backgroundColor: t.color ?? "transparent" }} />{t.color ?? "—"}</span></td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      <button onClick={() => startEdit(t)} className="rounded p-1 text-ink-dim hover:bg-rule hover:text-ink" aria-label={`Edit ${t.id}`}><Pencil className="h-4 w-4" /></button>
                      <button onClick={() => remove.mutate(t.id)} className="rounded p-1 text-ink-dim hover:bg-err-bg hover:text-err" aria-label={`Delete ${t.id}`}><Trash2 className="h-4 w-4" /></button>
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
