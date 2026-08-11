// SPDX-License-Identifier: MIT
import { Controller, Get, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { ZodValidationPipe } from "../common/zod.pipe";
import { SeriesService } from "./series.service";

const wantedQuery = z.object({ limit: z.coerce.number().int().positive().max(200).default(50) });
// eslint-disable-next-line no-useless-assignment  -- referenced only inside a NestJS decorator; ESLint 10 doesn't count decorator usage
const calendarQuery = z.object({ start: z.string().optional(), end: z.string().optional() });

@ApiTags("series")
@Controller("api/v1")
export class WantedController {
  constructor(private readonly series: SeriesService) {}

  @Get("wanted/missing")
  @ApiOperation({ summary: "Want/Missing: monitored episodes without files" })
  wanted(@Query(new ZodValidationPipe(wantedQuery)) q: { limit: number }) {
    return this.series.wantedMissing(q.limit);
  }

  @Get("calendar")
  @ApiOperation({ summary: "Upcoming episodes (air-dated) in a window" })
  calendar(@Query(new ZodValidationPipe(calendarQuery)) q: { start?: string; end?: string }) {
    return this.series.calendar(q.start, q.end);
  }
}
