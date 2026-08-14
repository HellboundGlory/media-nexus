// SPDX-License-Identifier: MIT
import { Body, Controller, Delete, Get, Param, Post, Put, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { createSeriesSchema, updateSeriesSchema, type CreateSeries, type UpdateSeriesBody } from "@medianexus/domain";
import { ZodValidationPipe } from "../common/zod.pipe";
import { SeriesService } from "./series.service";

const episodesQuery = z.object({ season: z.coerce.number().int().min(0).optional() });
const createEpisodesBody = z.object({
  seasonNumber: z.number().int().min(0),
  episodeNumbers: z.array(z.number().int().min(1)).min(1),
  title: z.string().optional(),
  airDateUtc: z.string().optional(),
});
const setMonitoredBody = z.object({ monitored: z.boolean() });

const listQuerySchema = z.object({
  search: z.string().optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

@ApiTags("series")
@Controller("api/v1/series")
export class SeriesController {
  constructor(private readonly series: SeriesService) {}

  @Get()
  @ApiOperation({ summary: "List series (paginated/filterable)" })
  list(@Query(new ZodValidationPipe(listQuerySchema)) query: unknown) {
    return this.series.list(query as { search?: string; page?: number; pageSize?: number });
  }

  @Get(":id")
  @ApiOperation({ summary: "Get a series" })
  get(@Param("id") id: string) {
    return this.series.get(id);
  }

  @Get(":id/seasons")
  @ApiOperation({ summary: "Seasons of a series" })
  seasons(@Param("id") id: string) {
    return this.series.seasons(id);
  }

  @Post()
  @ApiOperation({ summary: "Add a series to the library" })
  create(@Body(new ZodValidationPipe(createSeriesSchema)) body: CreateSeries) {
    return this.series.create(body);
  }

  @Put(":id")
  @ApiOperation({ summary: "Edit a series (partial; null clears qualityProfileId)" })
  update(@Param("id") id: string, @Body(new ZodValidationPipe(updateSeriesSchema)) body: UpdateSeriesBody) {
    return this.series.update(id, body);
  }

  @Put(":id/seasons/:seasonId")
  @ApiOperation({ summary: "Monitor/unmonitor a season (cascades to its episodes)" })
  setSeasonMonitored(@Param("id") id: string, @Param("seasonId") seasonId: string, @Body(new ZodValidationPipe(setMonitoredBody)) body: { monitored: boolean }) {
    return this.series.setSeasonMonitored(id, seasonId, body.monitored);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Remove a series" })
  remove(@Param("id") id: string) {
    return this.series.remove(id);
  }

  @Get(":id/episodes")
  @ApiOperation({ summary: "Episodes of a series (optional season filter)" })
  episodes(@Param("id") id: string, @Query(new ZodValidationPipe(episodesQuery)) q: { season?: number }) {
    return this.series.episodes(id, q.season);
  }

  @Post(":id/episodes")
  @ApiOperation({ summary: "Bulk-create episodes for a season (manual; metadata import automates later)" })
  createEpisodes(@Param("id") id: string, @Body(new ZodValidationPipe(createEpisodesBody)) body: z.infer<typeof createEpisodesBody>) {
    return this.series.createEpisodes(id, body);
  }

  @Put(":id/episodes/:episodeId")
  @ApiOperation({ summary: "Monitor/unmonitor an episode" })
  setMonitored(@Param("id") id: string, @Param("episodeId") episodeId: string, @Body(new ZodValidationPipe(setMonitoredBody)) body: { monitored: boolean }) {
    return this.series.setEpisodeMonitored(id, episodeId, body.monitored);
  }
}
