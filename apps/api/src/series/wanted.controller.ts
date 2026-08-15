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
    const merged = [
      ...episodes.map((e) => ({ ...e, mediaType: "series" as const })),
      ...movies,
    ];
    merged.sort((a, b) => {
      const da = a.mediaType === "series" ? a.airDateUtc : a.releaseDate;
      const db = b.mediaType === "series" ? b.airDateUtc : b.releaseDate;
      return (da ?? "").localeCompare(db ?? "");
    });
    return merged.slice(0, q.limit);
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
