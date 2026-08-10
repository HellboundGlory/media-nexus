// SPDX-License-Identifier: MIT
import { Body, Controller, Delete, Get, Param, Post, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { createSeriesSchema, type CreateSeries } from "@medianexus/domain";
import { ZodValidationPipe } from "../common/zod.pipe";
import { SeriesService } from "./series.service";

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

  @Delete(":id")
  @ApiOperation({ summary: "Remove a series" })
  remove(@Param("id") id: string) {
    return this.series.remove(id);
  }
}
