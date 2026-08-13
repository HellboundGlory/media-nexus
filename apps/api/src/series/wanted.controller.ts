// SPDX-License-Identifier: MIT
import { Controller, Get, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { ZodValidationPipe } from "../common/zod.pipe";
import { SeriesService } from "./series.service";
import { MoviesService } from "../movies/movies.service";

const wantedQuery = z.object({ limit: z.coerce.number().int().positive().max(200).default(50) });
// eslint-disable-next-line no-useless-assignment  -- referenced only inside a NestJS decorator; ESLint 10 doesn't count decorator usage
const calendarQuery = z.object({ start: z.string().optional(), end: z.string().optional() });

@ApiTags("series")
@Controller("api/v1")
export class WantedController {
  constructor(
    private readonly series: SeriesService,
    private readonly movies: MoviesService,
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
  @ApiOperation({ summary: "Upcoming episodes (air-dated) in a window" })
  calendar(@Query(new ZodValidationPipe(calendarQuery)) q: { start?: string; end?: string }) {
    return this.series.calendar(q.start, q.end);
  }
}
