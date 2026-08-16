// SPDX-License-Identifier: MIT
import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { ZodValidationPipe } from "../common/zod.pipe";
import { MetadataService } from "./metadata.service";
import { AdminGuard } from "../common/admin.guard";

const lookupQuery = z.object({ query: z.string().min(1), type: z.enum(["movie", "series"]).default("movie") });

const discoverQuery = z.object({
  mediaType: z.enum(["movie", "series"]).default("movie"),
  category: z.enum(["trending", "popular", "upcoming", "top_rated"]).default("trending"),
  page: z.coerce.number().int().min(1).max(500).default(1),
});
const discoverAddBody = z.object({
  mediaType: z.enum(["movie", "series"]),
  tmdbId: z.number().int().positive(),
  // Add-modal choices threaded through to create (QUALITYPROFILES-1 / UNI-014) — all optional;
  // the service defaults each to the historical literals when absent.
  qualityProfileId: z.string().optional(),
  rootFolderPath: z.string().optional(),
  tags: z.array(z.string()).optional(),
  seriesType: z.enum(["standard", "daily", "anime"]).optional(),
  monitored: z.boolean().optional(),
});

@ApiTags("metadata")
@UseGuards(AdminGuard)
@Controller()
export class MetadataController {
  constructor(private readonly metadata: MetadataService) {}

  @Get("api/v1/metadata/search")
  @ApiOperation({ summary: "Search TMDB for candidates to add" })
  lookup(@Query(new ZodValidationPipe(lookupQuery)) q: z.infer<typeof lookupQuery>) {
    return this.metadata.lookup(q.query, q.type);
  }

  @Post("api/v1/movies/:id/metadata")
  @ApiOperation({ summary: "Refresh movie metadata from TMDB" })
  refreshMovie(@Param("id") id: string) {
    return this.metadata.refreshMovie(id);
  }

  @Post("api/v1/series/:id/metadata")
  @ApiOperation({ summary: "Refresh series metadata + auto-create seasons/episodes from TMDB" })
  refreshSeries(@Param("id") id: string) {
    return this.metadata.refreshSeries(id);
  }

  @Get("api/v1/discover")
  @ApiOperation({ summary: "Browse TMDB trending/popular/upcoming/top-rated movies or TV shows" })
  discover(@Query(new ZodValidationPipe(discoverQuery)) q: z.infer<typeof discoverQuery>) {
    return this.metadata.discover(q.mediaType, q.category, q.page);
  }

  @Post("api/v1/discover/add")
  @ApiOperation({ summary: "Add a movie/series to the library from a TMDB discover result" })
  addFromDiscover(@Body(new ZodValidationPipe(discoverAddBody)) body: z.infer<typeof discoverAddBody>) {
    return this.metadata.addFromDiscover(body.mediaType, body.tmdbId, {
      qualityProfileId: body.qualityProfileId,
      rootFolderPath: body.rootFolderPath,
      tags: body.tags,
      seriesType: body.seriesType,
      monitored: body.monitored,
    });
  }
}
