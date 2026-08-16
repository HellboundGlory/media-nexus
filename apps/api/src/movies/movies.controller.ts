// SPDX-License-Identifier: MIT
import { Body, Controller, Delete, Get, Param, Post, Put, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import {
  createMovieSchema, updateMovieSchema,
  type CreateMovie, type UpdateMovieBody,
} from "@medianexus/domain";
import { ZodValidationPipe } from "../common/zod.pipe";
import { MoviesService, type ListQuery } from "./movies.service";
import { LibraryScanService } from "../library-scan/library-scan.service";

const listQuerySchema = z.object({
  search: z.string().optional(),
  monitored: z.enum(["true", "false"]).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

const renameBodySchema = z.object({ mediaFileIds: z.array(z.string()).default([]) });

const manageApplyBodySchema = z.object({
  removeStale: z.array(z.string()).default([]),
  importUntracked: z.array(z.string()).default([]),
});

@ApiTags("movies")
@Controller("api/v1/movies")
export class MoviesController {
  constructor(
    private readonly movies: MoviesService,
    private readonly scan: LibraryScanService,
  ) {}

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

  @Get(":id/credits")
  @ApiOperation({ summary: "Cast & crew of a movie" })
  credits(@Param("id") id: string) {
    return this.movies.credits(id);
  }

  @Post(":id/auto-search")
  @ApiOperation({ summary: "Search indexers for a movie and auto-grab the best release (one click)" })
  autoSearch(@Param("id") id: string) {
    return this.movies.autoSearchMovie(id);
  }

  @Get(":id/rename-preview")
  @ApiOperation({ summary: "Read-only preview of a rename under the current naming template" })
  renamePreview(@Param("id") id: string) {
    return this.movies.renamePreview(id);
  }

  @Post(":id/rename")
  @ApiOperation({ summary: "Execute a rename: move the requested files on disk and update their paths" })
  rename(@Param("id") id: string, @Body(new ZodValidationPipe(renameBodySchema)) body: { mediaFileIds: string[] }) {
    return this.movies.rename(id, body.mediaFileIds);
  }

  @Get(":id/files")
  @ApiOperation({ summary: "Media files of a movie" })
  files(@Param("id") id: string) {
    return this.movies.files(id);
  }

  @Get(":id/manage-files")
  @ApiOperation({ summary: "Scan-preview a movie's folder: untracked files on disk vs stale rows the DB tracks but disk is missing" })
  managePreview(@Param("id") id: string) {
    return this.scan.previewMovie(id);
  }

  @Post(":id/manage-files/apply")
  @ApiOperation({ summary: "Apply the user's Manage Files selection: import the checked untracked files and remove the checked stale rows (only what's ticked)" })
  manageApply(@Param("id") id: string, @Body(new ZodValidationPipe(manageApplyBodySchema)) body: { removeStale: string[]; importUntracked: string[] }) {
    return this.scan.applyMovie(id, body);
  }

  @Post()
  @ApiOperation({ summary: "Add a movie to the library" })
  create(@Body(new ZodValidationPipe(createMovieSchema)) body: CreateMovie) {
    return this.movies.create(body);
  }

  @Put(":id")
  @ApiOperation({ summary: "Edit a movie (partial; null clears qualityProfileId)" })
  update(@Param("id") id: string, @Body(new ZodValidationPipe(updateMovieSchema)) body: UpdateMovieBody) {
    return this.movies.update(id, body);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Remove a movie (opt-in: deleteFiles disposes files+folder, addImportExclusion adds a list-exclusion row)" })
  remove(@Param("id") id: string, @Body(new ZodValidationPipe(
    z.object({
      deleteFiles: z.boolean().optional(),
      addImportExclusion: z.boolean().optional(),
    }).default({}),
  )) body: { deleteFiles?: boolean; addImportExclusion?: boolean }) {
    return this.movies.remove(id, body);
  }
}
