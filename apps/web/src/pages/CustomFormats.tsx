// SPDX-License-Identifier: MIT
// CustomFormats — the settings CRUD surface for custom formats (QUALITYPROFILES-1 / UNI-015).
// Same card-grid + modal pattern as QualityProfiles, but a single narrow column (this editor is
// simpler than the profile editor): a name field plus a repeatable condition-row builder over
// customFormatSpecSchema's discriminated union (term / size / language / indexer), with a negate
// checkbox on every row. Each spec type produces a body valid against that schema; Save/Cancel/
// Delete-when-editing live in the footer.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Layers, Plus, Trash2 } from "lucide-react";
import { api } from "../api/client";
import type { CustomFormat, CustomFormatSpec, IndexerRow } from "../api/types";
import { Badge, ErrorState } from "../lib/ui";
import { Modal } from "../components/Modal";

type SpecType = CustomFormatSpec["type"];

/** Working shape of one condition row while editing — a superset holding every field across
 *  all four spec types; the save step projects it onto the exact CustomFormatSpec for its type. */
interface SpecRow {
  type: SpecType;
  term: string;
  useRegex: boolean;
  caseSensitive: boolean;
  min: string;
  max: string;
  language: string;
  indexerId: string;
  negate: boolean;
}

const SPEC_LABEL: Record<SpecType, string> = { term: "Term / Regex", size: "Size", language: "Language", indexer: "Indexer" };

const emptyRow = (): SpecRow => ({ type: "term", term: "", useRegex: false, caseSensitive: false, min: "", max: "", language: "", indexerId: "", negate: false });

function toRow(spec: CustomFormatSpec): SpecRow {
  return {
    type: spec.type,
    term: spec.type === "term" ? spec.term : "",
    useRegex: spec.type === "term" ? spec.useRegex : false,
    caseSensitive: spec.caseSensitive ?? false,
    min: spec.type === "size" && spec.min !== undefined ? String(spec.min) : "",
    max: spec.type === "size" && spec.max !== undefined ? String(spec.max) : "",
    language: spec.type === "language" ? spec.language : "",
    indexerId: spec.type === "indexer" ? spec.indexerId : "",
    negate: spec.negate,
  };
}

function toSpec(row: SpecRow): CustomFormatSpec {
  switch (row.type) {
    case "term":
      return { type: "term", term: row.term, useRegex: row.useRegex, negate: row.negate, caseSensitive: row.caseSensitive };
    case "size": {
      const min = row.min === "" ? undefined : Number(row.min);
      const max = row.max === "" ? undefined : Number(row.max);
      return { type: "size", min, max, negate: row.negate, caseSensitive: row.caseSensitive };
    }
    case "language":
      return { type: "language", language: row.language, negate: row.negate, caseSensitive: row.caseSensitive };
    case "indexer":
      return { type: "indexer", indexerId: row.indexerId, negate: row.negate, caseSensitive: row.caseSensitive };
  }
}

/** One-line card summary of a condition (e.g. `term: x265`, `size: >5GB`, `!language: en`). */
function specSummary(spec: CustomFormatSpec): { text: string; tone: "ok" | "warn" | "info" | "neutral" } {
  const neg = spec.negate ? "!" : "";
  switch (spec.type) {
    case "term": return { text: `${neg}term: ${spec.term}${spec.useRegex ? " /re" : ""}`, tone: "info" };
    case "size": {
      let s = "";
      if (spec.min !== undefined) s += `>${spec.min}B`;
      if (spec.max !== undefined) s += `${s ? " " : ""}<${spec.max}B`;
      return { text: `${neg}size: ${s}`, tone: "neutral" };
    }
    case "language": return { text: `${neg}lang: ${spec.language}`, tone: "ok" };
    case "indexer": return { text: `${neg}indexer: ${spec.indexerId}`, tone: "warn" };
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

  const formats = useQuery({ queryKey: ["custom-formats"], queryFn: () => api.get<CustomFormat[]>("/custom-formats") });
  const indexers = useQuery({ queryKey: ["indexers"], queryFn: () => api.get<IndexerRow[]>("/indexers") });

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

  const setRow = (i: number, patch: Partial<SpecRow>) => {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="flex items-center gap-2 font-display text-2xl font-bold uppercase tracking-[0.05em] text-ink">
          <Layers className="h-5 w-5" /> Custom Formats
        </h2>
        <p className="text-sm text-ink-dim">
          Named release-matching rules (terms/regex, size, language, indexer) that Quality Profiles score
          against to rank and gate releases. A format matches when every one of its conditions passes.
        </p>
      </div>

      {formats.isError ? <ErrorState error={formats.error} onRetry={() => formats.refetch()} /> : formats.isLoading ? (
        <p className="text-sm text-ink-dim">Loading…</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {(formats.data ?? []).map((f) => (
            <button
              key={f.id}
              onClick={() => openEdit(f)}
              className="flex flex-col items-start gap-3 rounded-xl border border-rule bg-surface p-4 text-left transition-colors hover:border-accent/50 hover:bg-rule/30"
            >
              <span className="font-display text-sm font-semibold uppercase tracking-[0.04em] text-ink">{f.name}</span>
              <span className="flex flex-wrap gap-1.5">
                {f.specs.map((s, i) => {
                  const sm = specSummary(s);
                  return <Badge key={i} tone={sm.tone}>{sm.text}</Badge>;
                })}
              </span>
            </button>
          ))}
          <button
            onClick={openNew}
            className="flex min-h-[6rem] items-center justify-center rounded-xl border border-dashed border-rule bg-surface text-ink-dim transition-colors hover:border-accent/60 hover:text-accent"
          >
            <span className="flex items-center gap-1.5 font-display text-sm font-semibold uppercase tracking-wide">
              <Plus className="h-4 w-4" /> Add format
            </span>
          </button>
        </div>
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
              <span className="block text-xs text-ink-dim">Conditions (format matches when all pass)</span>
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
                  </div>

                  {r.type === "size" && (
                    <div className="flex flex-wrap items-center gap-2 text-xs text-ink-dim">
                      <label className="flex items-center gap-1">min<input type="number" value={r.min} onChange={(e) => setRow(i, { min: e.target.value })} placeholder="bytes" className={`${inputCls} w-32`} /></label>
                      <label className="flex items-center gap-1">max<input type="number" value={r.max} onChange={(e) => setRow(i, { max: e.target.value })} placeholder="bytes" className={`${inputCls} w-32`} /></label>
                    </div>
                  )}
                  {r.type === "language" && (
                    <input value={r.language} onChange={(e) => setRow(i, { language: e.target.value })} placeholder="en" className={`${inputCls} w-32`} />
                  )}

                  <div className="flex flex-wrap items-center gap-3 text-xs text-ink-dim">
                    <label className="flex items-center gap-1.5"><input type="checkbox" checked={r.negate} onChange={(e) => setRow(i, { negate: e.target.checked })} className="h-3.5 w-3.5" /> negate</label>
                    {r.type === "term" && (
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
