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

/** 4-state legend under the poster grids (matches where upstream places it). CALENDAR-1: the
 *  calendar page reuses this verbatim; the optional `letters` flag (color-impaired mode there)
 *  prefixes each state with its C/M/U marker so status is never conveyed by color alone. */
export function CompletenessLegend({ letters = false }: { letters?: boolean }) {
  const item = (color: string, label: string, letter?: string) => (
    <span className="flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${color}`} />
      {letters && letter && <span className="font-semibold text-ink">{letter}</span>}
      {label}
    </span>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 text-xs text-ink-dim">
      {item("bg-ok", "Complete", "C")}
      {item("bg-warn", "Missing", "M")}
      {item("bg-upcoming", "Upcoming", "U")}
      {item("bg-rule", "Unmonitored")}
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

/** Calendar-event-level completeness (CALENDAR-1) — per single event (episode or movie), NOT the
 *  whole-series/whole-movie completeness above. A single event is complete once its file exists,
 *  missing once its air/release date has passed without one, and upcoming otherwise. Unmonitored
 *  (or a null date that hasn't passed) gives null — matching the legend's 4th state. Reuses the
 *  same Completeness type/colors as the rest of the app, not a new palette. */
export function calendarEventCompleteness(e: {
  monitored: boolean;
  hasFile: boolean;
  date: string | null;
}): Completeness | null {
  if (!e.monitored) return null;
  if (e.hasFile) return "complete";
  const t = e.date ? new Date(e.date).getTime() : NaN;
  return !Number.isNaN(t) && t <= Date.now() ? "missing" : "upcoming";
}

/** One-letter status marker for color-impaired mode (CALENDAR-1): C/M/U for the three colored
 *  states, nothing for unmonitored — so status is never conveyed by color alone. */
export function completenessLetter(value: Completeness | null): string | null {
  if (value === "complete") return "C";
  if (value === "missing") return "M";
  if (value === "upcoming") return "U";
  return null;
}
