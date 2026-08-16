// SPDX-License-Identifier: MIT
// Wanted — new 2-tab page (NAV-1 Phase 2). "Missing" is Activity.tsx's old wanted-tab content
// moved here verbatim (GET /wanted/missing); "Cutoff Unmet" is new, powered by the NAV-1 Phase 0
// GET /wanted/cutoff-unmet endpoint, showing each held file's current quality vs. the assigned
// profile's cutoff (names come from the quality registry so it reads like the mockup's
// "HDTV-720p, wants WEB-1080p" rather than raw ids).
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { WantedItem, CutoffUnmetItem, QualityRegistryItem } from "../api/types";
import { Badge, EmptyState, ErrorState, formatDate } from "../lib/ui";

type Tab = "missing" | "cutoff";

function epTag(item: { seasonNumber?: number; episodeNumber?: number }): string {
  if (item.seasonNumber === undefined || item.episodeNumber === undefined) return "—";
  return `S${String(item.seasonNumber).padStart(2, "0")}E${String(item.episodeNumber).padStart(2, "0")}`;
}

export default function Wanted() {
  const [tab, setTab] = useState<Tab>("missing");

  const missing = useQuery({ queryKey: ["wanted"], queryFn: () => api.get<WantedItem[]>("/wanted/missing") });
  const cutoff = useQuery({ queryKey: ["wanted-cutoff"], queryFn: () => api.get<CutoffUnmetItem[]>("/wanted/cutoff-unmet") });
  const registry = useQuery({ queryKey: ["quality-registry"], queryFn: () => api.get<QualityRegistryItem[]>("/quality-profiles/registry") });

  // Name maps from the static quality registry (never raw ids in the UI).
  const titleById = new Map((registry.data ?? []).map((r) => [r.id, r.title]));
  const titleByKey = new Map((registry.data ?? []).map((r) => [r.key, r.title]));
  const qualityTitle = (src: string, res: string) => titleByKey.get(`${src}:${res}`) ?? (res ? `${src} · ${res}` : src);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-display text-2xl font-bold uppercase tracking-[0.05em] text-ink">Wanted</h2>
        <p className="text-sm text-ink-dim">Episodes and movies missing or below their profile's cutoff.</p>
      </div>

      <div className="flex w-fit gap-1 rounded-lg border border-rule bg-surface p-1">
        {(["missing", "cutoff"] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`rounded-md px-4 py-1.5 text-sm font-display font-semibold uppercase tracking-wide transition-colors ${tab === t ? "bg-accent text-accent-ink" : "text-ink-dim hover:bg-bg hover:text-ink"}`}>
            {t === "missing" ? "Missing" : "Cutoff Unmet"}
          </button>
        ))}
      </div>

      {tab === "missing" && (missing.isError ? <ErrorState error={missing.error} onRetry={() => missing.refetch()} /> : (missing.data?.length ?? 0) === 0 ? (
        <EmptyState title="Nothing wanted" hint="Monitored movies and episodes without files show here — run Auto-grab missing to fetch them." />
      ) : (
        <div className="overflow-hidden rounded-lg border border-rule">
          <table className="w-full text-left text-sm">
            <thead className="bg-bg text-[10px] font-semibold uppercase tracking-wide text-ink-dim">
              <tr><th className="px-3 py-2">Title</th><th className="px-3 py-2">Ep</th><th className="px-3 py-2">Date</th><th className="px-3 py-2">Status</th></tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {missing.data?.map((w) => (
                <tr key={`${w.mediaType}-${w.id}`}>
                  <td className="px-3 py-2 font-medium text-ink">{w.mediaType === "series" ? w.seriesTitle : w.title}</td>
                  <td className="px-3 py-2">{w.mediaType === "series" ? epTag(w) : "—"}</td>
                  <td className="px-3 py-2 text-ink-dim">{(() => { const d = w.mediaType === "series" ? w.airDateUtc : w.releaseDate; return d ? formatDate(d).slice(0, 10) : "—"; })()}</td>
                  <td className="px-3 py-2"><Badge tone="warn">wanted</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {tab === "cutoff" && (cutoff.isError ? <ErrorState error={cutoff.error} onRetry={() => cutoff.refetch()} /> : (cutoff.data?.length ?? 0) === 0 ? (
        <EmptyState title="Everything meets its cutoff" hint="Titles with a file below their profile cutoff will appear here, ready to upgrade." />
      ) : (
        <div className="overflow-hidden rounded-lg border border-rule">
          <table className="w-full text-left text-sm">
            <thead className="bg-bg text-[10px] font-semibold uppercase tracking-wide text-ink-dim">
              <tr><th className="px-3 py-2">Title</th><th className="px-3 py-2">Ep</th><th className="px-3 py-2">Quality</th><th className="px-3 py-2">Cutoff</th><th className="px-3 py-2">Date</th></tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {cutoff.data?.map((c) => (
                <tr key={`${c.mediaType}-${c.id}`}>
                  <td className="px-3 py-2 font-medium text-ink">{c.mediaType === "series" ? c.seriesTitle : c.title}</td>
                  <td className="px-3 py-2">{c.mediaType === "series" ? epTag(c) : "—"}</td>
                  <td className="px-3 py-2 text-ink-dim">{c.quality ? qualityTitle(c.quality.source, c.quality.resolution) : "—"}</td>
                  <td className="px-3 py-2"><Badge tone="ok">{c.cutoffQualityId != null ? (titleById.get(c.cutoffQualityId) ?? String(c.cutoffQualityId)) : "—"}</Badge></td>
                  <td className="px-3 py-2 text-ink-dim">{(() => { const d = c.mediaType === "series" ? c.airDateUtc : c.releaseDate; return d ? formatDate(d).slice(0, 10) : "—"; })()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
