// SPDX-License-Identifier: MIT
// MediaPosterCard — the shared poster card for the Movies/Series library pages (UNI-028 layout
// half). Based on Discover.tsx's DiscoverCard. Reuses the `posterUrl` helper from Poster.tsx.
// A title/year/monitored footer, a thin completeness color bar (movies only — the list response
// carries per-movie `hasFile` but no per-series file-completeness, so series cards never render
// it), and a checkbox overlay in selection mode.
import { Film } from "lucide-react";
import { clsx } from "clsx";
import { Badge } from "../lib/ui";
import { posterUrl } from "./detail/Poster";

export function MediaPosterCard({
  id,
  title,
  year,
  images,
  monitored,
  hasFile,
  selecting,
  selected,
  onToggleSelect,
  onClick,
}: {
  id: string;
  title: string;
  year: string | number | null;
  images?: { coverType: string; url: string }[];
  monitored: boolean;
  /** Movie-only: drives the bottom completeness bar. Omit for series (never renders it). */
  hasFile?: boolean;
  selecting: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onClick: (id: string) => void;
}) {
  const url = posterUrl(images);
  // Bottom bar: accent/ok when monitored AND has a file; warn when monitored AND missing a
  // file; nothing when unmonitored (or when hasFile isn't provided — series).
  const barTone = hasFile === undefined ? null : monitored ? (hasFile ? "ok" : "warn") : null;

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
        <p className="truncate text-sm font-medium text-ink" title={title}>{title}</p>
        <div className="mt-auto flex items-center justify-between text-xs text-ink-dim">
          <span>{year ?? "—"}</span>
          <Badge tone={monitored ? "ok" : "warn"}>{monitored ? "monitored" : "unmonitored"}</Badge>
        </div>
      </div>
      {barTone && (
        <div className={clsx("h-1 w-full", barTone === "ok" ? "bg-ok" : "bg-warn")} />
      )}
    </div>
  );
}
