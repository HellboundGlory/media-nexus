// SPDX-License-Identifier: MIT
// SeasonPill — the colored progress pill (e.g. "7 / 9") for a season, plus a hover popover
// (Total / Monitored / With files / Size on disk) per the approved mockup. Stats are computed
// from the episode list + media_file size mapping passed in by the caller (the page owns the
// /episodes and /files queries).
import { formatBytes } from "../../lib/ui";

export interface SeasonStats {
  total: number;
  monitored: number;
  withFiles: number;
  sizeOnDisk: number;
}

export function SeasonPill({ stats }: { stats: SeasonStats }) {
  // Colored by completion: full green in the ok family, partial accent, none stays muted.
  const color = stats.withFiles === 0 ? "bg-rule text-ink-dim"
    : stats.withFiles === stats.total ? "bg-ok text-accent-ink"
    : "bg-accent text-accent-ink";
  return (
    <span className="group relative inline-flex items-center gap-1">
      <span className={`inline-flex items-center rounded px-2 py-0.5 font-display text-xs font-bold tabular-nums ${color}`}>
        {stats.withFiles} / {stats.total}
      </span>
      <span className="pointer-events-none absolute bottom-full left-0 z-20 mb-2 hidden whitespace-nowrap rounded-lg border border-rule bg-surface px-3 py-2 text-xs shadow-lg group-hover:block">
        Total: <span className="tabular-nums">{stats.total}</span> · Monitored: <span className="tabular-nums">{stats.monitored}</span> · With files: <span className="tabular-nums">{stats.withFiles}</span> · Size: {formatBytes(stats.sizeOnDisk)}
      </span>
    </span>
  );
}
