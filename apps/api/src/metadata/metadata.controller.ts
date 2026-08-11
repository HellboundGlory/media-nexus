// SPDX-License-Identifier: MIT
import { Controller, Get, Param, Post, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { ZodValidationPipe } from "../common/zod.pipe";
import { MetadataService } from "./metadata.service";

const lookupQuery = z.object({ query: z.string().min(1), type: z.enum(["movie", "series"]).default("movie") });

@ApiTags("metadata")
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
}
