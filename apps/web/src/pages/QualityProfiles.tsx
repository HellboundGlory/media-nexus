// SPDX-License-Identifier: MIT
// QualityProfiles — the settings CRUD surface for quality profiles (QUALITYPROFILES-1 /
// UNI-014). Card grid of existing profiles + a dashed "+" add card; clicking a card opens a
// real two-column modal (upstream Sonarr/Radarr pattern): left column = name, upgrade toggle,
// "upgrade until" quality select, custom-format score thresholds and the per-format score
// list; right column = the quality ladder rendered BEST at top / WORST at bottom (a
// display-only reversal of the registry's worst→best storage order — `items` is persisted
// unchanged). Delete is only offered when editing an existing profile, and an in-use profile's
// 409 is surfaced verbatim rather than swallowed.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gauge, Plus, Trash2 } from "lucide-react";
import { api } from "../api/client";
import type { QualityProfile, QualityRegistryItem, CustomFormat } from "../api/types";
import { ErrorState, Badge } from "../lib/ui";
import { Modal } from "../components/Modal";

interface Draft {
  name: string;
  items: number[];
  cutoffQualityId: number;
  upgradeAllowed: boolean;
  formatScores: Record<string, number>;
  minFormatScore: number;
  cutoffFormatScore: number;
}

// A brand-new profile defaults to "anything allowed" (mirrors the seeded "Any" profile), so
// creating one can never accidentally lock every future title out.
function freshDraft(registryIds: number[]): Draft {
  return {
    name: "",
    items: [...registryIds],
    cutoffQualityId: registryIds.length ? registryIds[registryIds.length - 1] : 0,
    upgradeAllowed: true,
    formatScores: {},
    minFormatScore: 0,
    cutoffFormatScore: 0,
  };
}

function toDraft(p: QualityProfile): Draft {
  return {
    name: p.name,
    items: [...p.items],
    cutoffQualityId: p.cutoffQualityId,
    upgradeAllowed: p.upgradeAllowed,
    formatScores: p.formatScores ?? {},
    minFormatScore: p.minFormatScore ?? 0,
    cutoffFormatScore: p.cutoffFormatScore ?? 0,
  };
}

const inputCls = "w-full rounded-lg border border-rule bg-transparent px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";
const numCls = "w-28 rounded-lg border border-rule bg-transparent px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

export default function QualityProfiles() {
  const qc = useQueryClient();
  const [openId, setOpenId] = useState<string | null | "new">(null);
  const [draft, setDraft] = useState<Draft>(freshDraft([]));
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const profiles = useQuery({ queryKey: ["quality-profiles"], queryFn: () => api.get<QualityProfile[]>("/quality-profiles") });
  const registry = useQuery({ queryKey: ["quality-registry"], queryFn: () => api.get<QualityRegistryItem[]>("/quality-profiles/registry") });
  const formats = useQuery({ queryKey: ["custom-formats"], queryFn: () => api.get<CustomFormat[]>("/custom-formats") });

  const registryIds = registry.data?.map((r) => r.id) ?? [];
  const titleById = new Map((registry.data ?? []).map((r) => [r.id, r.title]));
  const hasFormats = (formats.data?.length ?? 0) > 0;

  const openNew = () => { setOpenId("new"); setDraft(freshDraft(registryIds)); setDeleteError(null); };
  const openEdit = (p: QualityProfile) => { setOpenId(p.id); setDraft(toDraft(p)); setDeleteError(null); };

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: draft.name.trim(),
        items: draft.items,
        cutoffQualityId: draft.cutoffQualityId,
        upgradeAllowed: draft.upgradeAllowed,
        formatScores: draft.formatScores,
        minFormatScore: draft.minFormatScore,
        cutoffFormatScore: draft.cutoffFormatScore,
      };
      if (openId === "new") await api.post<QualityProfile>("/quality-profiles", body);
      else await api.put<QualityProfile>(`/quality-profiles/${openId}`, body);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["quality-profiles"] }); setOpenId(null); },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/quality-profiles/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["quality-profiles"] }); setOpenId(null); },
    onError: (e) => setDeleteError(e instanceof Error ? e.message : "Delete failed"),
  });

  const editing = openId !== null && openId !== "new";

  // Re-clamp the cutoff to the best still-allowed quality whenever a checked quality is
  // removed (an invariant the backend re-enforces: cutoff must be one of items).
  const toggleQuality = (id: number) => {
    setDraft((d) => {
      const on = d.items.includes(id);
      if (on) {
        if (d.items.length === 1) return d; // at least one allowed quality is required
        const next = d.items.filter((x) => x !== id);
        const cutoff = d.cutoffQualityId === id ? next[next.length - 1] : d.cutoffQualityId;
        return { ...d, items: next, cutoffQualityId: cutoff };
      }
      // insert preserving worst→best order (the ladder's storage convention)
      const next = [...d.items, id].sort((a, b) => a - b);
      return { ...d, items: next };
    });
  };

  // The ladder is stored worst→best; render BEST at top by reversing it.
  const ladder = [...(registry.data ?? [])].reverse();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="flex items-center gap-2 font-display text-2xl font-bold uppercase tracking-[0.05em] text-ink">
          <Gauge className="h-5 w-5" /> Quality Profiles
        </h2>
        <p className="text-sm text-ink-dim">
          Ordered lists of allowed release qualities plus cutoff/upgrade rules and custom-format scores.
          A profile assigned to a movie or series gates what the decision engine will grab.
        </p>
      </div>

      {profiles.isError ? <ErrorState error={profiles.error} onRetry={() => profiles.refetch()} /> : profiles.isLoading ? (
        <p className="text-sm text-ink-dim">Loading…</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {(profiles.data ?? []).map((p) => (
            <button
              key={p.id}
              onClick={() => openEdit(p)}
              className="flex flex-col items-start gap-3 rounded-xl border border-rule bg-surface p-4 text-left transition-colors hover:border-accent/50 hover:bg-rule/30"
            >
              <span className="flex items-center gap-2 font-display text-sm font-semibold uppercase tracking-[0.04em] text-ink">
                {p.name}
                {p.isDefault && <Badge tone="info">default</Badge>}
              </span>
              <span className="flex flex-wrap gap-1.5">
                {p.items.map((id) => (
                  <span key={id} className="rounded bg-neutral-bg px-2 py-0.5 text-xs font-semibold text-neutral-ink">{titleById.get(id) ?? id}</span>
                ))}
              </span>
              <Badge tone="ok">cutoff: {titleById.get(p.cutoffQualityId) ?? p.cutoffQualityId}</Badge>
            </button>
          ))}
          <button
            onClick={openNew}
            className="flex min-h-[7rem] items-center justify-center rounded-xl border border-dashed border-rule bg-surface text-ink-dim transition-colors hover:border-accent/60 hover:text-accent"
          >
            <span className="flex items-center gap-1.5 font-display text-sm font-semibold uppercase tracking-wide">
              <Plus className="h-4 w-4" /> Add profile
            </span>
          </button>
        </div>
      )}

      {openId !== null && (
        <Modal
          title={editing ? "Edit Quality Profile" : "Add Quality Profile"}
          wide
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
                disabled={save.isPending || !draft.name.trim() || draft.items.length === 0}
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

          <div className="grid gap-6 p-4 lg:grid-cols-2">
            {/* LEFT column — profile metadata + custom-format scores */}
            <div className="space-y-3">
              <label className="block">
                <span className="mb-1 block text-xs text-ink-dim">Name</span>
                <input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} placeholder="My profile" className={inputCls} />
              </label>

              <label className="flex items-center gap-2 text-sm text-ink-dim">
                <input type="checkbox" checked={draft.upgradeAllowed} onChange={(e) => setDraft((d) => ({ ...d, upgradeAllowed: e.target.checked }))} className="h-4 w-4" />
                Upgrades Allowed
              </label>

              {draft.upgradeAllowed && (
                <label className="block">
                  <span className="mb-1 block text-xs text-ink-dim">Upgrade Until</span>
                  <select
                    value={draft.cutoffQualityId}
                    onChange={(e) => setDraft((d) => ({ ...d, cutoffQualityId: Number(e.target.value) }))}
                    className="w-full rounded-lg border border-rule bg-surface px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40"
                  >
                    {draft.items.map((id) => (
                      <option key={id} value={id}>{titleById.get(id) ?? id}</option>
                    ))}
                  </select>
                </label>
              )}

              {hasFormats && (
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="mb-1 block text-xs text-ink-dim">Minimum Custom Format Score</span>
                    <input type="number" value={draft.minFormatScore} onChange={(e) => setDraft((d) => ({ ...d, minFormatScore: Number(e.target.value) }))} className={numCls} />
                  </label>
                  {draft.upgradeAllowed && (
                    <label className="block">
                      <span className="mb-1 block text-xs text-ink-dim">Upgrade Until Custom Format Score</span>
                      <input type="number" value={draft.cutoffFormatScore} onChange={(e) => setDraft((d) => ({ ...d, cutoffFormatScore: Number(e.target.value) }))} className={numCls} />
                    </label>
                  )}
                </div>
              )}

              {hasFormats && (
                <div className="space-y-2">
                  <span className="block text-xs text-ink-dim">Custom Format Scores</span>
                  <div className="max-h-56 space-y-1.5 overflow-y-auto rounded-lg border border-rule p-2">
                    {formats.data!.map((f) => (
                      <label key={f.id} className="flex items-center justify-between gap-2 text-sm">
                        <span className="truncate text-ink">{f.name}</span>
                        <input
                          type="number"
                          value={draft.formatScores[f.id] ?? 0}
                          onChange={(e) => setDraft((d) => ({ ...d, formatScores: { ...d.formatScores, [f.id]: Number(e.target.value) } }))}
                          className={numCls}
                        />
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* RIGHT column — the quality ladder, BEST at top */}
            <div className="space-y-2">
              <span className="block text-xs text-ink-dim">Allowed Qualities<span className="ml-1 text-ink-dim/70">(best at top)</span></span>
              <div className="max-h-[30rem] space-y-1 overflow-y-auto rounded-lg border border-rule p-2">
                {ladder.map((r) => {
                  const on = draft.items.includes(r.id);
                  return (
                    <label key={r.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-bg">
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={on && draft.items.length === 1}
                        onChange={() => toggleQuality(r.id)}
                        className="h-4 w-4"
                      />
                      <span className={on ? "text-ink" : "text-ink-dim/70"}>{r.title}</span>
                    </label>
                  );
                })}
              </div>
              {draft.items.length === 1 && <p className="text-xs text-warn-ink">At least one quality must remain allowed.</p>}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
