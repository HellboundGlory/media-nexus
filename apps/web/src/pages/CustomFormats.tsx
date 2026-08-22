// SPDX-License-Identifier: MIT
// CustomFormats — the settings CRUD surface for custom formats (QUALITYPROFILES-1 / UNI-015,
// extended by SON-025 + UNI-025 + SON-025b): the condition-row builder now covers all 10
// condition types (term/size/language/indexer/resolution/source/modifier/releaseGroup/
// releaseType/indexerFlag), has a `required` checkbox per row (the upstream OR-within-type
// grouping semantics), and supports Import/Export of the Sonarr/Radarr custom-format JSON so
// community format packs (Dictionarry/Dumpstarr etc.) can be pasted in and formats downloaded.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Plus, Trash2, Upload } from "lucide-react";
import { api } from "../api/client";
import type { CustomFormat, CustomFormatSpec, IndexerRow, QualityRegistryItem, SourceValue, ResolutionValue, ModifierValue, IndexerFlagValue } from "../api/types";
import { Badge, ErrorState } from "../lib/ui";
import { Modal } from "../components/Modal";

type SpecType = CustomFormatSpec["type"];

/** Working shape of one condition row while editing — a superset holding every field across
 *  all spec types; the save step projects it onto the exact CustomFormatSpec for its type. */
interface SpecRow {
  type: SpecType;
  term: string;
  useRegex: boolean;
  caseSensitive: boolean;
  min: string;
  max: string;
  language: string;
  indexerId: string;
  resolution: ResolutionValue;
  source: SourceValue;
  modifier: ModifierValue;
  releaseGroup: string;
  releaseType: "single" | "multi" | "season";
  indexerFlag: IndexerFlagValue;
  negate: boolean;
  required: boolean;
}

const SPEC_LABEL: Record<SpecType, string> = {
  term: "Term / Regex", size: "Size", language: "Language", indexer: "Indexer",
  resolution: "Resolution", source: "Source", modifier: "Modifier",
  releaseGroup: "Release Group", releaseType: "Release Type", indexerFlag: "Indexer Flag",
};

const emptyRow = (): SpecRow => ({
  type: "term", term: "", useRegex: false, caseSensitive: false, min: "", max: "",
  language: "", indexerId: "", resolution: "unknown", source: "unknown", modifier: "none",
  releaseGroup: "", releaseType: "single", indexerFlag: "freeleech", negate: false, required: true,
});

function toRow(spec: CustomFormatSpec): SpecRow {
  return {
    type: spec.type,
    term: spec.type === "term" ? spec.term : "",
    useRegex: (spec.type === "term" || spec.type === "releaseGroup") ? spec.useRegex ?? false : false,
    caseSensitive: spec.caseSensitive ?? false,
    min: spec.type === "size" && spec.min !== undefined ? String(spec.min) : "",
    max: spec.type === "size" && spec.max !== undefined ? String(spec.max) : "",
    language: spec.type === "language" ? spec.language : "",
    indexerId: spec.type === "indexer" ? spec.indexerId : "",
    resolution: spec.type === "resolution" ? spec.resolution : "unknown",
    source: spec.type === "source" ? spec.source : "unknown",
    modifier: spec.type === "modifier" ? spec.modifier : "none",
    releaseGroup: spec.type === "releaseGroup" ? spec.releaseGroup : "",
    releaseType: spec.type === "releaseType" ? spec.releaseType : "single",
    indexerFlag: spec.type === "indexerFlag" ? spec.flag : "freeleech",
    negate: spec.negate,
    required: spec.required !== false,
  };
}

function toSpec(row: SpecRow): CustomFormatSpec {
  const base = { negate: row.negate, required: row.required, caseSensitive: row.caseSensitive };
  switch (row.type) {
    case "term": return { type: "term", term: row.term, useRegex: row.useRegex, ...base };
    case "size": {
      const min = row.min === "" ? undefined : Number(row.min);
      const max = row.max === "" ? undefined : Number(row.max);
      return { type: "size", min, max, ...base };
    }
    case "language": return { type: "language", language: row.language, ...base };
    case "indexer": return { type: "indexer", indexerId: row.indexerId, ...base };
    case "resolution": return { type: "resolution", resolution: row.resolution, ...base };
    case "source": return { type: "source", source: row.source, ...base };
    case "modifier": return { type: "modifier", modifier: row.modifier, ...base };
    case "releaseGroup": return { type: "releaseGroup", releaseGroup: row.releaseGroup, useRegex: row.useRegex, ...base };
    case "releaseType": return { type: "releaseType", releaseType: row.releaseType, ...base };
    case "indexerFlag": return { type: "indexerFlag", flag: row.indexerFlag, ...base };
  }
}

/** One-line card summary of a condition (e.g. `term: x265`, `size: >5GB`, `!lang: en`).
 *  Tone encodes polarity per the upstream Radarr convention — negated conditions render
 *  danger, normal ones render the project's positive token (ok) — so the card's color
 *  answers positive-vs-negated at a glance while the text still names the field. */
function specSummary(spec: CustomFormatSpec): { text: string; tone: "ok" | "warn" | "info" | "neutral" | "danger" } {
  const neg = spec.negate ? "!" : "";
  const tone = spec.negate ? "danger" : "ok";
  switch (spec.type) {
    case "term": return { text: `${neg}term: ${spec.term}${spec.useRegex ? " /re" : ""}`, tone };
    case "size": {
      let s = "";
      if (spec.min !== undefined) s += `>${spec.min}B`;
      if (spec.max !== undefined) s += `${s ? " " : ""}<${spec.max}B`;
      return { text: `${neg}size: ${s}`, tone };
    }
    case "language": return { text: `${neg}lang: ${spec.language}`, tone };
    case "indexer": return { text: `${neg}indexer: ${spec.indexerId}`, tone };
    case "resolution": return { text: `${neg}res: ${spec.resolution}`, tone };
    case "source": return { text: `${neg}src: ${spec.source}`, tone };
    case "modifier": return { text: `${neg}mod: ${spec.modifier}`, tone };
    case "releaseGroup": return { text: `${neg}group: ${spec.releaseGroup}${spec.useRegex ? " /re" : ""}`, tone };
    case "releaseType": return { text: `${neg}type: ${spec.releaseType}`, tone };
    case "indexerFlag": return { text: `${neg}flag: ${spec.flag}`, tone };
  }
}

const inputCls = "rounded-lg border border-rule bg-transparent px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";
const selectCls = "rounded-lg border border-rule bg-surface px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

export default function CustomFormats() {
  const qc = useQueryClient();
  const [openId, setOpenId] = useState<string | null | "new">(null);
  const [name, setName] = useState("");
  const [rows, setRows] = useState<SpecRow[]>([emptyRow()]);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [importInfo, setImportInfo] = useState<string | null>(null);

  const formats = useQuery({ queryKey: ["custom-formats"], queryFn: () => api.get<CustomFormat[]>("/custom-formats") });
  const indexers = useQuery({ queryKey: ["indexers"], queryFn: () => api.get<IndexerRow[]>("/indexers") });
  // Source/resolution/modifier dropdown values are derived from the live registry API so they
  // can't drift from the backend's enums (RAD-010).
  const registry = useQuery({ queryKey: ["quality-registry"], queryFn: () => api.get<QualityRegistryItem[]>("/quality-profiles/registry") });

  const resolutions = [...new Set((registry.data ?? []).map((r) => r.resolution))];
  const sources = [...new Set((registry.data ?? []).map((r) => r.source))];
  const modifiers = [...new Set((registry.data ?? []).map((r) => r.modifier))];

  const editing = openId !== null && openId !== "new";

  const openNew = () => { setOpenId("new"); setName(""); setRows([emptyRow()]); setDeleteError(null); };
  const openEdit = (f: CustomFormat) => { setOpenId(f.id); setName(f.name); setRows(f.specs.map(toRow)); setDeleteError(null); };

  const save = useMutation({
    mutationFn: async () => {
      const body = { name: name.trim(), specs: rows.filter((r) => r.type !== "term" || r.term.trim() !== "").map(toSpec) };
      if (openId === "new") await api.post<CustomFormat>("/custom-formats", body);
      else await api.put<CustomFormat>(`/custom-formats/${openId}`, body);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["custom-formats"] }); setOpenId(null); },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/custom-formats/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["custom-formats"] }); setOpenId(null); },
    onError: (e) => setDeleteError(e instanceof Error ? e.message : "Delete failed"),
  });

  const importFormat = useMutation({
    mutationFn: async (text: string) => {
      let body: unknown;
      try { body = JSON.parse(text); }
      catch { throw new Error("Invalid JSON — check the pasted format"); }
      return api.post<{ format: CustomFormat; imported: number; skipped: { implementation: string; reason: string }[] }>("/custom-formats/import", body);
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["custom-formats"] });
      const skipped = res.skipped?.length ?? 0;
      setImportError(null);
      setImportInfo(skipped > 0
        ? `Imported ${res.imported} condition(s); skipped ${skipped} unsupported: ${res.skipped.map((s) => s.implementation).join(", ")}`
        : `Imported "${res.format.name}" with ${res.imported} condition(s).`);
      setImportText("");
    },
    onError: (e) => { setImportError(e instanceof Error ? e.message : "Import failed"); setImportInfo(null); },
  });

  const exportFormat = (f: CustomFormat) => {
    api.get<{ name: string; specifications: unknown[] }>(`/custom-formats/${f.id}/export`).then((body) => {
      const blob = new Blob([JSON.stringify(body, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${f.name.replace(/[^a-z0-9_-]+/gi, "-")}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
  };

  const setRow = (i: number, patch: Partial<SpecRow>) => {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };

  return (
    <div className="space-y-6">
      {formats.isError ? <ErrorState error={formats.error} onRetry={() => formats.refetch()} /> : formats.isLoading ? (
        <p className="text-sm text-ink-dim">Loading…</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {(formats.data ?? []).map((f) => (
            <div key={f.id} className="group flex flex-col rounded-xl border border-rule bg-surface p-4 transition-colors hover:border-accent/50">
              <button onClick={() => openEdit(f)} className="flex flex-1 flex-col items-start gap-3 text-left">
                <span className="font-display text-sm font-semibold uppercase tracking-[0.04em] text-ink">{f.name}</span>
                <span className="flex flex-wrap gap-1.5">
                  {f.specs.map((s, i) => {
                    const sm = specSummary(s);
                    return <Badge key={i} tone={sm.tone}>{sm.text}</Badge>;
                  })}
                </span>
              </button>
              <button
                onClick={() => exportFormat(f)}
                className="mt-3 inline-flex items-center gap-1 self-start rounded-md border border-rule px-2 py-1 text-[11px] font-medium text-ink-dim hover:bg-rule hover:text-ink"
                title="Export as Sonarr/Radarr JSON"
              >
                <Download className="h-3 w-3" /> Export
              </button>
            </div>
          ))}
          <button
            onClick={() => { setImportOpen(true); setImportText(""); setImportError(null); setImportInfo(null); }}
            className="flex min-h-[5rem] items-center justify-center rounded-xl border border-dashed border-rule bg-surface text-ink-dim transition-colors hover:border-accent/60 hover:text-accent"
          >
            <span className="flex items-center gap-1.5 font-display text-sm font-semibold uppercase tracking-wide">
              <Upload className="h-4 w-4" /> Import
            </span>
          </button>
          <button
            onClick={openNew}
            className="flex min-h-[5rem] items-center justify-center rounded-xl border border-dashed border-rule bg-surface text-ink-dim transition-colors hover:border-accent/60 hover:text-accent"
          >
            <span className="flex items-center gap-1.5 font-display text-sm font-semibold uppercase tracking-wide">
              <Plus className="h-4 w-4" /> Add format
            </span>
          </button>
        </div>
      )}

      {importOpen && (
        <Modal
          title="Import Custom Format"
          onClose={() => setImportOpen(false)}
          footer={
            <>
              <button onClick={() => setImportOpen(false)} className="rounded-lg border border-rule bg-bg px-3 py-1.5 text-sm text-ink hover:bg-rule">Close</button>
              <button
                onClick={() => importFormat.mutate(importText)}
                disabled={importFormat.isPending || !importText.trim()}
                className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50"
              >
                {importFormat.isPending ? "Importing…" : "Import"}
              </button>
            </>
          }
        >
          {(importError || importInfo) && (
            <div className={`border-b border-rule px-4 py-2 text-xs ${importError ? "bg-err-bg text-err-ink" : "bg-ok-bg text-ok-ink"}`}>
              {importError ?? importInfo}
            </div>
          )}
          <div className="space-y-3 p-4">
            <label className="block">
              <span className="mb-1 block text-xs text-ink-dim">Paste the Sonarr/Radarr custom-format JSON</span>
              <textarea
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                rows={10}
                placeholder='{"name":"My Format","includeCustomFormatWhenRenaming":false,"specifications":[{...}]}'
                className={`${inputCls} w-full font-mono text-xs`}
              />
            </label>
            <p className="text-xs text-ink-dim">Conditions with an implementation we don't support (e.g. Indexer Flag, Edition, Year) are skipped and reported — never silently dropped.</p>
          </div>
        </Modal>
      )}

      {openId !== null && (
        <Modal
          title={editing ? "Edit Custom Format" : "Add Custom Format"}
          onClose={() => setOpenId(null)}
          footer={
            <>
              {editing && (
                <button
                  onClick={() => remove.mutate(openId as string)}
                  disabled={remove.isPending}
                  className="mr-auto inline-flex items-center gap-1.5 rounded-lg bg-err/10 px-3 py-1.5 text-sm font-semibold uppercase tracking-wide text-err hover:bg-err/20 disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" /> {remove.isPending ? "Deleting…" : "Delete"}
                </button>
              )}
              <button onClick={() => setOpenId(null)} className="rounded-lg border border-rule bg-bg px-3 py-1.5 text-sm text-ink hover:bg-rule">Cancel</button>
              <button
                onClick={() => save.mutate()}
                disabled={save.isPending || !name.trim() || rows.length === 0}
                className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50"
              >
                {save.isPending ? "Saving…" : "Save"}
              </button>
            </>
          }
        >
          {(save.isError || deleteError) && (
            <div className="border-b border-rule bg-err-bg px-4 py-2 text-xs text-err-ink">
              {deleteError ?? (save.error instanceof Error ? save.error.message : "Save failed")}
            </div>
          )}

          <div className="space-y-3 p-4">
            <label className="block">
              <span className="mb-1 block text-xs text-ink-dim">Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. x265 / 1080p Remux" className={`${inputCls} w-full`} />
            </label>

            <div className="space-y-2">
              <span className="block text-xs text-ink-dim">Conditions (same-type conditions are OR'd unless a member is marked Required)</span>
              {rows.map((r, i) => (
                <div key={i} className="space-y-2 rounded-lg border border-rule p-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <select value={r.type} onChange={(e) => setRow(i, { type: e.target.value as SpecType })} className={selectCls}>
                      {(Object.keys(SPEC_LABEL) as SpecType[]).map((t) => <option key={t} value={t}>{SPEC_LABEL[t]}</option>)}
                    </select>
                    {r.type === "term" && (
                      <input value={r.term} onChange={(e) => setRow(i, { term: e.target.value })} placeholder="x265" className={`${inputCls} w-44`} />
                    )}
                    {r.type === "indexer" && (
                      <select value={r.indexerId} onChange={(e) => setRow(i, { indexerId: e.target.value })} className={selectCls}>
                        <option value="">Select indexer…</option>
                        {(indexers.data ?? []).map((ix) => <option key={ix.id} value={ix.id}>{ix.name}</option>)}
                      </select>
                    )}
                    {r.type === "resolution" && (
                      <select value={r.resolution} onChange={(e) => setRow(i, { resolution: e.target.value as ResolutionValue })} className={selectCls}>
                        {resolutions.map((v) => <option key={v} value={v}>{v}</option>)}
                      </select>
                    )}
                    {r.type === "source" && (
                      <select value={r.source} onChange={(e) => setRow(i, { source: e.target.value as SourceValue })} className={selectCls}>
                        {sources.map((v) => <option key={v} value={v}>{v}</option>)}
                      </select>
                    )}
                    {r.type === "modifier" && (
                      <select value={r.modifier} onChange={(e) => setRow(i, { modifier: e.target.value as ModifierValue })} className={selectCls}>
                        {modifiers.map((v) => <option key={v} value={v}>{v}</option>)}
                      </select>
                    )}
                    {r.type === "releaseType" && (
                      <select value={r.releaseType} onChange={(e) => setRow(i, { releaseType: e.target.value as SpecRow["releaseType"] })} className={selectCls}>
                        <option value="single">Single episode</option>
                        <option value="multi">Multi episode</option>
                        <option value="season">Season pack</option>
                      </select>
                    )}
                    {r.type === "indexerFlag" && (
                      <select value={r.indexerFlag} onChange={(e) => setRow(i, { indexerFlag: e.target.value as IndexerFlagValue })} className={selectCls}>
                        <option value="freeleech">Freeleech</option>
                        <option value="freeleech75">75% Freeleech</option>
                        <option value="halfleech">Halfleech</option>
                        <option value="freeleech25">25% Freeleech</option>
                        <option value="doubleUpload">Double Upload</option>
                      </select>
                    )}
                  </div>

                  {r.type === "size" && (
                    <div className="flex flex-wrap items-center gap-2 text-xs text-ink-dim">
                      <label className="flex items-center gap-1">min<input type="number" value={r.min} onChange={(e) => setRow(i, { min: e.target.value })} placeholder="bytes" className={`${inputCls} w-32`} /></label>
                      <label className="flex items-center gap-1">max<input type="number" value={r.max} onChange={(e) => setRow(i, { max: e.target.value })} placeholder="bytes" className={`${inputCls} w-32`} /></label>
                    </div>
                  )}
                  {(r.type === "language" || r.type === "releaseGroup") && (
                    <input value={r.type === "language" ? r.language : r.releaseGroup} onChange={(e) => setRow(i, r.type === "language" ? { language: e.target.value } : { releaseGroup: e.target.value })} placeholder={r.type === "language" ? "en" : "e.g. DON"} className={`${inputCls} w-44`} />
                  )}

                  <div className="flex flex-wrap items-center gap-3 text-xs text-ink-dim">
                    <label className="flex items-center gap-1.5"><input type="checkbox" checked={r.required} onChange={(e) => setRow(i, { required: e.target.checked })} className="h-3.5 w-3.5" /> required</label>
                    <label className="flex items-center gap-1.5"><input type="checkbox" checked={r.negate} onChange={(e) => setRow(i, { negate: e.target.checked })} className="h-3.5 w-3.5" /> negate</label>
                    {(r.type === "term" || r.type === "releaseGroup") && (
                      <>
                        <label className="flex items-center gap-1.5"><input type="checkbox" checked={r.useRegex} onChange={(e) => setRow(i, { useRegex: e.target.checked })} className="h-3.5 w-3.5" /> regex</label>
                        <label className="flex items-center gap-1.5"><input type="checkbox" checked={r.caseSensitive} onChange={(e) => setRow(i, { caseSensitive: e.target.checked })} className="h-3.5 w-3.5" /> case-sensitive</label>
                      </>
                    )}
                    <button
                      onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                      disabled={rows.length === 1}
                      className="ml-auto rounded p-1 text-ink-dim hover:bg-err-bg hover:text-err disabled:opacity-40"
                      aria-label="Remove condition"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
              <button
                onClick={() => setRows((rs) => [...rs, emptyRow()])}
                className="inline-flex items-center gap-1.5 rounded-lg border border-rule bg-surface px-3 py-1.5 text-sm text-ink-dim hover:bg-rule hover:text-ink"
              >
                <Plus className="h-3.5 w-3.5" /> Add condition
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
