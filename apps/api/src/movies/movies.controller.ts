// SPDX-License-Identifier: MIT
import { Body, Controller, Delete, Get, Param, Post, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import {
  createMovieSchema, type CreateMovie,
} from "@medianexus/domain";
import { ZodValidationPipe } from "../common/zod.pipe";
import { MoviesService, type ListQuery } from "./movies.service";

const listQuerySchema = z.object({
  search: z.string().optional(),
  monitored: z.enum(["true", "false"]).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

@ApiTags("movies")
@Controller("api/v1/movies")
export class MoviesController {
  constructor(private readonly movies: MoviesService) {}

  @Get()
  @ApiOperation({ summary: "List movies (paginated/filterable)" })
  list(@Query(new ZodValidationPipe(listQuerySchema)) query: ListQuery) {
    return this.movies.list(query);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get a movie" })
  get(@Param("id") id: string) {
    return this.movies.get(id);
  }

  @Post()
  @ApiOperation({ summary: "Add a movie to the library" })
  create(@Body(new ZodValidationPipe(createMovieSchema)) body: CreateMovie) {
    return this.movies.create(body);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Remove a movie" })
  remove(@Param("id") id: string) {
    return this.movies.remove(id);
  }
}
