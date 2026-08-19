// SPDX-License-Identifier: MIT
import { Controller, Get, Header, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { ZodValidationPipe } from "../common/zod.pipe";
import { SeriesService } from "./series.service";
import { MoviesService } from "../movies/movies.service";
import { MediaRepository } from "../media/media.repository";
import { ApiError } from "@medianexus/shared";
import { wantedOverfetchCap, type KeysetCursor } from "../media/library.helpers";
import { buildIcal } from "../calendar/ical";

const wantedQuery = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
  cursor: z.string().optional(),
});
const calendarQuery = z.object({ start: z.string().optional(), end: z.string().optional() });

/** Fair-share slot allocation for the wanted/cutoff merge (WANTEDMISSING-1). A naive merge of
 *  the two already-sliced per-type lists (concat + date-sort + slice `limit`) lets one media
 *  type's backlog — if it's larger AND chronologically older — consume every slot and silently
 *  hide the other type entirely, even though that type has wanted items. So instead of a pure
 *  top-N-by-date selection, each side gets a guaranteed base half of `limit` (or everything it
 *  has when it has fewer than half); any leftover from an exhausted side spills to the other.
 *  Symmetric, so there's no "which side is starved" special case — it falls out of the min()s. */
function allocateSlots(limit: number, countMovies: number, countEpisodes: number): { takeMovies: number; takeEpisodes: number } {
  const base = Math.floor(limit / 2);
  let takeMovies = Math.min(countMovies, base);
  let takeEpisodes = Math.min(countEpisodes, base);
  let leftover = limit - takeMovies - takeEpisodes;
  if (leftover > 0) {
    const extraMovies = Math.min(countMovies - takeMovies, leftover);
    takeMovies += extraMovies;
    leftover -= extraMovies;
    const extraEpisodes = Math.min(countEpisodes - takeEpisodes, leftover);
    takeEpisodes += extraEpisodes;
  }
  return { takeMovies, takeEpisodes };
}

type MediaType = "movie" | "series";
function mergeDate(
  a: { mediaType: MediaType; airDateUtc?: string | null; releaseDate?: string | null },
  b: { mediaType: MediaType; airDateUtc?: string | null; releaseDate?: string | null },
): number {
  const da = a.mediaType === "series" ? a.airDateUtc : a.releaseDate;
  const db = b.mediaType === "series" ? b.airDateUtc : b.releaseDate;
  return (da ?? "").localeCompare(db ?? "");
}

/** The opaque wire cursor: one keyset position per media type (the last `(date, id)` each type
 *  contributed to the previous page), base64 of `{"m":{d,id}|null,"e":{d,id}|null}`. The client
 *  treats it as fully opaque — it never parses it, only echoes it back. */
interface WireCursor {
  m: { d: string | null; id: string } | null;
  e: { d: string | null; id: string } | null;
}

/** Wire shape ({d, id}) -> domain keyset ({date, id}); the service-level keyset uses the full
 *  word because the services are indifferent to the wire encoding. */
function toKeyset(w: { d: string | null; id: string } | null): KeysetCursor | null {
  return w ? { date: w.d, id: w.id } : null;
}

function decodeCursor(raw: string | undefined): WireCursor {
  if (!raw) return { m: null, e: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    throw new ApiError({ code: "VALIDATION_ERROR", message: "invalid cursor" });
  }
  const shape = (v: unknown): v is { d: string | null; id: string } | null =>
    v === null || (typeof v === "object" && v !== null && typeof (v as { d?: unknown }).d === "string" && typeof (v as { id?: unknown }).id === "string");
  const o = parsed as Record<string, unknown>;
  if (typeof parsed !== "object" || parsed === null || !("m" in o) || !("e" in o) || !shape(o.m) || !shape(o.e)) {
    throw new ApiError({ code: "VALIDATION_ERROR", message: "invalid cursor" });
  }
  return { m: o.m as { d: string | null; id: string } | null, e: o.e as { d: string | null; id: string } | null };
}

function encodeCursor(c: WireCursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64");
}

/** Advance one media type's keyset cursor onto the last row that type contributed this page, or
 *  carry its incoming cursor forward unchanged when it contributed nothing (a type that had no
 *  candidates this page doesn't move — keyset pagination is self-healing, so any matching rows
 *  that later appear will surface naturally). Consumes the domain-shape candidates and returns
 *  the wire shape. */
function advance(
  incoming: KeysetCursor | null,
  consumed: { date: string | null; id: string }[],
  took: number,
): { d: string | null; id: string } | null {
  if (took > 0 && consumed.length > 0 && consumed[took - 1]) {
    const last = consumed[took - 1];
    return { d: last.date, id: last.id };
  }
  return incoming ? { d: incoming.date, id: incoming.id } : null;
}

@ApiTags("series")
@Controller("api/v1")
export class WantedController {
  constructor(
    private readonly series: SeriesService,
    private readonly movies: MoviesService,
    private readonly repo: MediaRepository,
  ) {}

  /** Want/Missing: monitored titles without files, past their availability gate (movies)
   *  — merged across both media types (roadmap C1) rather than a movie-specific endpoint,
   *  matching the rest of this project's "one implementation" convention. Episode rows are
   *  returned in their original shape (they still carry seriesId), tagged with
   *  `mediaType: "series"`; movie rows carry `mediaType: "movie"` and no season/episode
   *  fields. Date-sorted (air date / release date) across both, capped at the shared limit.
   *  Paginated with a per-type keyset `cursor` (WANTEDPAGE-1): fair-share allocation keeps
   *  every page, not just page 1, representing both media types. */
  @Get("wanted/missing")
  @ApiOperation({ summary: "Want/Missing: monitored movies and episodes without files (paged, cursor)" })
  async wanted(@Query(new ZodValidationPipe(wantedQuery)) q: { limit: number; cursor?: string }) {
    const cursor = decodeCursor(q.cursor);
    const [episodeRes, movieRes] = await Promise.all([
      this.series.wantedMissing(q.limit, toKeyset(cursor.e)),
      this.movies.wantedMissing(q.limit, toKeyset(cursor.m)),
    ]);
    const cap = wantedOverfetchCap(q.limit);
    const { takeMovies, takeEpisodes } = allocateSlots(q.limit, movieRes.candidates.length, episodeRes.candidates.length);
    const episodes = episodeRes.candidates.slice(0, takeEpisodes);
    const movies = movieRes.candidates.slice(0, takeMovies);
    const merged = [
      ...episodes.map((e) => ({ ...e, mediaType: "series" as const })),
      ...movies,
    ];
    // Re-sort the picked rows by date so the final list still reads chronologically within itself
    // (it's just no longer a pure top-N-by-date selection across types).
    merged.sort(mergeDate);

    // hasMore per type: we have more candidates in hand than we took, OR the raw query hit the
    // overfetch cap (so there may be more rows we didn't fetch). Same heuristic imprecision the
    // existing single-page overfetch-and-filter code already accepts — not a new regression.
    const episodesHasMore = episodes.length < episodeRes.candidates.length || episodeRes.rawRowCount === cap;
    const moviesHasMore = movies.length < movieRes.candidates.length || movieRes.rawRowCount === cap;
    const hasMore = episodesHasMore || moviesHasMore;

    const next = {
      m: advance(toKeyset(cursor.m), movieRes.candidates.map((c) => ({ date: c.releaseDate, id: c.id })), takeMovies),
      e: advance(toKeyset(cursor.e), episodeRes.candidates.map((c) => ({ date: c.airDateUtc, id: c.id })), takeEpisodes),
    };

    return {
      items: merged,
      nextCursor: hasMore ? encodeCursor(next) : null,
      hasMore,
    };
  }

  /** Cutoff Unmet (NAV-1 Phase 0): monitored titles/episodes that have a file below their
   *  quality profile's cutoff — merged across both media types like `wanted/missing`, using
   *  `meetsCutoff()` from the domain (not a reimplementation). Each row carries a `quality`
   *  (the best held file's, movie; the episode's file's, series) and `cutoffQualityId` so the
   *  UI can render "current vs. cutoff". Same per-type keyset pagination as wanted/missing. */
  @Get("wanted/cutoff-unmet")
  @ApiOperation({ summary: "Cutoff Unmet: monitored movies/episodes with a file below their profile cutoff (paged, cursor)" })
  async cutoffUnmet(@Query(new ZodValidationPipe(wantedQuery)) q: { limit: number; cursor?: string }) {
    const cursor = decodeCursor(q.cursor);
    const [episodeRes, movieRes] = await Promise.all([
      this.series.cutoffUnmet(q.limit, toKeyset(cursor.e)),
      this.movies.cutoffUnmet(q.limit, toKeyset(cursor.m)),
    ]);
    const cap = wantedOverfetchCap(q.limit);
    // Same fair-share allocation as wanted/missing (WANTEDMISSING-1) — both overfetch internally,
    // so the merge just can't let one type's backlog hide the other.
    const { takeMovies, takeEpisodes } = allocateSlots(q.limit, movieRes.candidates.length, episodeRes.candidates.length);
    const episodes = episodeRes.candidates.slice(0, takeEpisodes);
    const movies = movieRes.candidates.slice(0, takeMovies);
    const merged = [...episodes, ...movies];
    merged.sort(mergeDate);

    const episodesHasMore = episodes.length < episodeRes.candidates.length || episodeRes.rawRowCount === cap;
    const moviesHasMore = movies.length < movieRes.candidates.length || movieRes.rawRowCount === cap;
    const hasMore = episodesHasMore || moviesHasMore;

    const next = {
      m: advance(toKeyset(cursor.m), movieRes.candidates.map((c) => ({ date: c.releaseDate, id: c.id })), takeMovies),
      e: advance(toKeyset(cursor.e), episodeRes.candidates.map((c) => ({ date: c.airDateUtc, id: c.id })), takeEpisodes),
    };

    return {
      items: merged,
      nextCursor: hasMore ? encodeCursor(next) : null,
      hasMore,
    };
  }

  @Get("calendar")
  @ApiOperation({ summary: "Calendar: movie release dates + episode air dates in a window (media-neutral, date-sorted)" })
  calendar(@Query(new ZodValidationPipe(calendarQuery)) q: { start?: string; end?: string }) {
    return this.repo.calendar(q.start, q.end);
  }

  @Get("calendar/ical")
  @Header("Content-Type", "text/calendar; charset=utf-8")
  @ApiOperation({ summary: "iCal (RFC 5545) feed of movie releases + episode air dates — subscribe from an external calendar app via ?apikey= (the *arr calendar-feed convention)" })
  async calendarIcal() {
    // Wider default window than the JSON feed's 14-day: a calendar app polls a feed URL on its own
    // schedule, so include ~2 weeks of trailing days for context plus the next ~90 days of upcoming
    // airings/releases — a useful subscription horizon without ballooning the payload.
    const now = Date.now();
    const entries = await this.repo.calendar(
      new Date(now - 14 * 24 * 3600 * 1000).toISOString(),
      new Date(now + 90 * 24 * 3600 * 1000).toISOString(),
    );
    return buildIcal(entries);
  }
}
