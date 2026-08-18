// SPDX-License-Identifier: MIT
// MediaPosterCard — the shared poster card for the Movies/Series library pages (UNI-028 layout
// half). Based on Discover.tsx's DiscoverCard. Reuses the `posterUrl` helper from Poster.tsx.
// A title/year/monitored footer, a thin completeness color bar (SERIESSTATUS-1: now both media
// types — complete/missing/upcoming via the caller-provided `completeness`, the mockup's shared
// 4-state concept), and a checkbox overlay in selection mode.
import { Film } from "lucide-react";
import { clsx } from "clsx";
import { Badge } from "../lib/ui";
import { posterUrl } from "./detail/Poster";
import { completenessBarClass, type Completeness } from "./Completeness";

/** UNI-029 pass 1: Tailwind grid column class for a given poster-size option (shared by both
 *  library pages so the Maps of size->columns never drifts between Movies and Series). */
export function posterGridClass(size: "small" | "medium" | "large"): string {
  switch (size) {
    case "small": return "grid-cols-4 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8";
    case "large": return "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5";
    default: return "grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6";
  }
}

export function MediaPosterCard({
  id,
  title,
  year,
  images,
  monitored,
  completeness,
  selecting,
  selected,
  onToggleSelect,
  onClick,
  showTitle = true,
  qualityProfileName,
}: {
  id: string;
  title: string;
  year: string | number | null;
  images?: { coverType: string; url: string }[];
  monitored: boolean;
  /** Drives the bottom completeness bar (SERIESSTATUS-1). Null/omitted → no bar (unmonitored or
   *  no data). Callers derive it per media type — movies from hasFile+release gate, series from
   *  the backend aggregate. */
  completeness?: Completeness | null;
  selecting: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onClick: (id: string) => void;
  /** UNI-029 pass 1: when false, hide the title/year footer text but keep the Monitored pill. */
  showTitle?: boolean;
  /** UNI-029 pass 1: when the "Show Quality Profile" option is on and a name is resolved, show it. */
  qualityProfileName?: string | null;
}) {
  const url = posterUrl(images);
  // Bottom bar: only for monitored titles — complete (blue) / missing (amber) / upcoming (violet);
  // nothing when unmonitored or there's no completeness data.
  const barClass = monitored ? completenessBarClass(completeness) : null;

  return (
    <div
      onClick={() => (selecting ? onToggleSelect(id) : onClick(id))}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (selecting) onToggleSelect(id);
          else onClick(id);
        }
      }}
      className="group flex cursor-pointer flex-col overflow-hidden rounded-lg border border-rule bg-surface text-left hover:border-accent/50"
    >
      <div className="relative aspect-[2/3] w-full bg-track">
        {url ? (
          <img src={url} alt={title} loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-ink-dim">
            <Film className="h-8 w-8" />
          </div>
        )}
        {selecting && (
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect(id)}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Select ${title}`}
            className="absolute left-2 top-2 h-4 w-4"
          />
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1 p-2">
        {showTitle && <p className="truncate text-sm font-medium text-ink" title={title}>{title}</p>}
        <div className="mt-auto flex items-center justify-between text-xs text-ink-dim">
          <span>{showTitle ? (year ?? "—") : ""}</span>
          <Badge tone={monitored ? "ok" : "warn"}>{monitored ? "monitored" : "unmonitored"}</Badge>
        </div>
        {qualityProfileName && <span className="truncate text-[10px] text-ink-dim">{qualityProfileName}</span>}
      </div>
      {barClass && (
        <div className={clsx("h-1 w-full", barClass)} />
      )}
    </div>
  );
}
