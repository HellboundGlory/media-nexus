// SPDX-License-Identifier: MIT
import { Controller, Get, Header, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { ZodValidationPipe } from "../common/zod.pipe";
import { SeriesService } from "./series.service";
import { MoviesService } from "../movies/movies.service";
import { MediaRepository } from "../media/media.repository";
import { buildIcal } from "../calendar/ical";

const wantedQuery = z.object({ limit: z.coerce.number().int().positive().max(200).default(50) });
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
   *  fields. Date-sorted (air date / release date) across both, capped at the shared limit. */
  @Get("wanted/missing")
  @ApiOperation({ summary: "Want/Missing: monitored movies and episodes without files" })
  async wanted(@Query(new ZodValidationPipe(wantedQuery)) q: { limit: number }) {
    const [episodes, movies] = await Promise.all([
      this.series.wantedMissing(q.limit),
      this.movies.wantedMissing(q.limit),
    ]);
    // Fair-share allocation (WANTEDMISSING-1): guarantee both media types are represented so a
    // large, older episode backlog can't hide every missing movie (or vice-versa).
    const { takeMovies, takeEpisodes } = allocateSlots(q.limit, movies.length, episodes.length);
    const merged = [
      ...episodes.slice(0, takeEpisodes).map((e) => ({ ...e, mediaType: "series" as const })),
      ...movies.slice(0, takeMovies),
    ];
    // Re-sort the picked rows by date so the final list still reads chronologically within itself
    // (it's just no longer a pure top-N-by-date selection across types).
    merged.sort(mergeDate);
    return merged;
  }

  /** Cutoff Unmet (NAV-1 Phase 0): monitored titles/episodes that have a file below their
   *  quality profile's cutoff — merged across both media types like `wanted/missing`, using
   *  `meetsCutoff()` from the domain (not a reimplementation). Each row carries a `quality`
   *  (the best held file's, movie; the episode's file's, series) and `cutoffQualityId` so the
   *  UI can render "current vs. cutoff". */
  @Get("wanted/cutoff-unmet")
  @ApiOperation({ summary: "Cutoff Unmet: monitored movies/episodes with a file below their profile cutoff" })
  async cutoffUnmet(@Query(new ZodValidationPipe(wantedQuery)) q: { limit: number }) {
    const [episodes, movies] = await Promise.all([
      this.series.cutoffUnmet(q.limit),
      this.movies.cutoffUnmet(q.limit),
    ]);
    // Same fair-share allocation as wanted/missing (WANTEDMISSING-1) — both overfetch internally,
    // so the merge just can't let one type's backlog hide the other.
    const { takeMovies, takeEpisodes } = allocateSlots(q.limit, movies.length, episodes.length);
    const merged = [
      ...episodes.slice(0, takeEpisodes),
      ...movies.slice(0, takeMovies),
    ];
    merged.sort(mergeDate);
    return merged;
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
