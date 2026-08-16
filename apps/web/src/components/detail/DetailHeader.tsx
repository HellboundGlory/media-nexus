// SPDX-License-Identifier: MIT
// DetailHeader — the shared poster-header skeleton for the movie and series detail pages
// (DETAILPAGE-FE1). Everything the two pages have in common lives here; the genuinely
// differing bits (title meta, release dates, action buttons, readout cells) come in as props
// or children rather than being hardcoded inside. Per the corrections: ONE TMDB rating badge
// (IMDb/RT/Trakt deliberately deferred), collection chip is plain text (BE3 chip-only), trailer
// link only when trailerId present, release-dates row only when at least one date exists.
import { type ReactNode } from "react";
import { Play, Star, ExternalLink } from "lucide-react";
import { Badge } from "../../lib/ui";
import { Poster } from "./Poster";

export interface ReadoutCell {
  label: string;
  value: ReactNode;
}

export function DetailHeader({
  title,
  images,
  metaLine,
  rating,
  genres,
  overview,
  trailerId,
  collectionName,
  releaseDates,
  readout,
  actions,
  footer,
  mediaType,
  tmdbId,
  imdbId,
}: {
  title: string;
  images?: { coverType: string; url: string }[];
  /** The compact meta line: year · certification · runtime · status (caller assembles). */
  metaLine: ReactNode;
  /** TMDB vote_average; badge hidden entirely when null. */
  rating: number | null;
  genres: string[];
  overview: string;
  trailerId: string | null;
  /** Movie-only: plain-text collection chip; hidden when absent. */
  collectionName?: string | null;
  /** Movie-only: present release dates (inCinemas/digital/physical). Row hidden when empty. */
  releaseDates?: string[];
  /** The console-style readout strip cells. */
  readout: ReadoutCell[];
  /** Action bar buttons (interactive search, preview rename, monitored lamp, delete…). */
  actions?: ReactNode;
  /** Optional full-width strip below the header (e.g. file/size summary). */
  footer?: ReactNode;
  /** Which TMDb path segment to use (movie vs tv) when building the external reference link. */
  mediaType: "movie" | "series";
  /** TMDb id — required on both media types; chip rendered whenever present. */
  tmdbId: number | null;
  /** IMDb id — optional; chip rendered only when present. */
  imdbId: string | null;
}) {
  const hasDates = releaseDates && releaseDates.length > 0;
  const dateLabel: { [k: number]: string } = { 0: "Cinemas", 1: "Digital", 2: "Physical" };
  const tmdb = rating != null;
  return (
    <div className="overflow-hidden rounded-xl border border-rule bg-surface">
      <div className="flex flex-col gap-5 p-5 sm:flex-row">
        <Poster title={title} images={images} />
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="font-display text-3xl font-bold uppercase leading-tight tracking-[0.05em] text-ink">{title}</h2>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-display text-sm font-medium uppercase tracking-[0.04em] text-ink-dim">
                {metaLine}
              </div>
            </div>
          </div>

          {/* Ratings + external-reference row — the TMDB rating chip and the Trailer/TMDb/IMDb
              reference chips folded into ONE row (DETAILPAGE-FE3), directly below the title/meta
              line and above the genre/collection chips. Renders whenever ANY of {rating, trailerId,
              tmdbId, imdbId} is present (a title can have links but no score). Source is TMDB on both
              media types (refreshMovie/refreshSeries both set tmdbRating from the TmdbProvider). */}
          {(tmdb || trailerId || tmdbId != null || imdbId) && (
            <div className="flex flex-wrap items-center gap-1.5">
              {tmdb && (
                <span className="inline-flex items-center gap-1.5 rounded bg-accent px-2 py-1 tabular-nums">
                  <Star className="h-3.5 w-3.5 text-accent-ink" />
                  <span className="font-display text-sm font-bold text-accent-ink">{rating.toFixed(1)}</span>
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-accent-ink/70">TMDB</span>
                </span>
              )}
              {trailerId && (
                <a
                  href={`https://www.youtube.com/watch?v=${trailerId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 rounded bg-accent/15 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-accent hover:bg-accent/25"
                >
                  <Play className="h-3.5 w-3.5" /> Trailer
                </a>
              )}
              {tmdbId != null && (
                <a
                  href={`https://www.themoviedb.org/${mediaType === "series" ? "tv" : "movie"}/${tmdbId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 rounded bg-accent/15 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-accent hover:bg-accent/25"
                >
                  <ExternalLink className="h-3.5 w-3.5" /> TMDb
                </a>
              )}
              {imdbId && (
                <a
                  href={`https://www.imdb.com/title/${imdbId}/`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 rounded bg-accent/15 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-accent hover:bg-accent/25"
                >
                  <ExternalLink className="h-3.5 w-3.5" /> IMDb
                </a>
              )}
            </div>
          )}

          {(genres.length > 0 || collectionName) && (
            <div className="flex flex-wrap items-center gap-1.5">
              {genres.map((g) => <Badge key={g} tone="info">{g}</Badge>)}
              {collectionName && <Badge tone="ok">{collectionName}</Badge>}
            </div>
          )}

          {overview && <p className="max-w-prose text-sm leading-relaxed text-ink-dim">{overview}</p>}

          {hasDates && (
            <div className="flex flex-wrap gap-2">
              {releaseDates!.map((d, i) => (
                <span key={i} className="inline-flex items-center gap-1.5 rounded border border-rule bg-bg px-2 py-1 text-xs text-ink-dim">
                  <span className="font-medium text-ink">{dateLabel[i]} ·</span>
                  {d.slice(0, 10)}
                </span>
              ))}
            </div>
          )}

          {/* Console-style readout strip */}
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-rule bg-rule sm:grid-cols-4">
            {readout.map((r) => (
              <div key={r.label} className="bg-bg px-3 py-2">
                <div className="font-display text-[10px] font-medium uppercase tracking-[0.08em] text-ink-dim">{r.label}</div>
                <div className="font-display text-lg font-bold uppercase tracking-[0.05em] tabular-nums text-ink">{r.value}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* External-reference chips no longer have their own row — they live inside the ratings
          row above (DETAILPAGE-FE3). The action bar follows. */}
      {actions && (
        <div className="flex flex-wrap items-center gap-2 border-t border-rule bg-bg/60 px-5 py-3">
          {actions}
        </div>
      )}

      {footer && <div className="border-t border-rule px-5 py-3">{footer}</div>}
    </div>
  );
}
