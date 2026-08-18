// SPDX-License-Identifier: MIT
// Shared 4-state "completeness" concept (SERIESSTATUS-1) — used identically by Movie and Series
// poster cards, table views and detail pages. One color set, one meaning:
//   complete  (blue  / ok)      — monitored, have everything released/aired so far
//   missing   (amber / warn)    — monitored, released/aired and not downloaded
//   upcoming  (violet / upcoming) — monitored, nothing released/aired yet
//   unmonitored / no data       — no bar/badge (matches prior behavior)
// Deliberately NOT per-media-type divergent legends and no Queued/Downloading state.
import { Badge } from "../lib/ui";

export type Completeness = "complete" | "missing" | "upcoming";

/** Bottom-poster-bar colour for a completeness state (null = no bar). */
export function completenessBarClass(value: Completeness | null | undefined): string | null {
  if (value === "complete") return "bg-ok";
  if (value === "missing") return "bg-warn";
  if (value === "upcoming") return "bg-upcoming";
  return null;
}

export function completenessBadgeTone(value: Completeness): "ok" | "warn" | "upcoming" {
  return value === "complete" ? "ok" : value === "missing" ? "warn" : "upcoming";
}

/** Detail/table pill. Series carries an aired-but-missing episode count; movies have none. */
export function CompletenessBadge({ value, missingCount }: { value: Completeness | null | undefined; missingCount?: number }) {
  if (!value) return null;
  if (value === "complete") return <Badge tone="ok">Complete</Badge>;
  if (value === "missing") return (
    <Badge tone="warn">
      Missing{missingCount != null ? ` ${missingCount} ${missingCount === 1 ? "episode" : "episodes"}` : ""}
    </Badge>
  );
  return <Badge tone="upcoming">Upcoming</Badge>;
}

/** 4-state legend under the poster grids (matches where upstream places it). */
export function CompletenessLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 text-xs text-ink-dim">
      <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-ok" /> Complete</span>
      <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-warn" /> Missing</span>
      <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-upcoming" /> Upcoming</span>
      <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-rule" /> Unmonitored</span>
    </div>
  );
}

/**
 * Movie completeness (SERIESSTATUS-1): monitored + hasFile → complete; monitored + no file whose
 * release gate hasn't cleared → upcoming; else (released, not downloaded) → missing. Mirrors the
 * domain's `hasMinimumAvailability()` gate inline so the web app doesn't depend on the backend
 * package. A movie never shows a count — it's one file.
 */
export function movieCompleteness(m: {
  monitored: boolean;
  hasFile: boolean;
  minimumAvailability?: string | null;
  releaseDate?: string | null;
}): Completeness | null {
  if (!m.monitored) return null;
  if (m.hasFile) return "complete";
  const released =
    m.minimumAvailability === "announced" || m.minimumAvailability === "deleted"
      ? true
      : m.releaseDate
        ? (() => { const d = new Date(m.releaseDate); return !Number.isNaN(d.getTime()) && d.getTime() <= Date.now(); })()
        : false;
  return released ? "missing" : "upcoming";
}

/** Series completeness gated on the series itself being monitored (unmonitored → no badge). */
export function seriesCompleteness(s: { monitored: boolean; completeness?: Completeness | null }): Completeness | null {
  return s.monitored ? (s.completeness ?? null) : null;
}
