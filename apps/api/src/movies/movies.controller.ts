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
  // UNI-029: server-side sort + filter (movies has the "missing" filter; Monitored/Unmonitored
  // come through `monitored`). Anything outside these enums is rejected with a clean 400.
  sort: z.enum(["title", "year", "added", "monitored"]).optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
  filter: z.enum(["all", "missing"]).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

const renameBodySchema = z.object({ mediaFileIds: z.array(z.string()).default([]) });

const manageApplyBodySchema = z.object({
  removeStale: z.array(z.string()).default([]),
  importUntracked: z.array(z.string()).default([]),
});

// ---- Bulk actions (UNI-020): one request fans out over the existing single-item update()/
// remove(). The per-item edit patch reuses updateMovieSchema (all-optional = "No Change" when a
// field is omitted) via .pick(), excluding title/folderName/tags which bulk-edit doesn't touch
// (tags has its own endpoint; title/folderName bulk-editing makes no sense).
const bulkEditMovieSchema = updateMovieSchema.pick({
  monitored: true,
  qualityProfileId: true,
  rootFolderPath: true,
  minimumAvailability: true,
}).extend({ ids: z.array(z.string()).min(1, "select at least one movie") });

const bulkTagsSchema = z.object({
  ids: z.array(z.string()).min(1, "select at least one movie"),
  tagIds: z.array(z.string()).default([]),
  mode: z.enum(["add", "remove", "replace"]),
});

const bulkDeleteMovieSchema = z.object({
  ids: z.array(z.string()).min(1, "select at least one movie"),
  deleteFiles: z.boolean().optional(),
  addImportExclusion: z.boolean().optional(),
});

const bulkRenameSchema = z.object({
  ids: z.array(z.string()).min(1, "select at least one movie"),
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

  @Post("bulk-edit")
  @ApiOperation({ summary: "Bulk-edit selected movies (UNI-020): only fields present are applied per item; per-id success/failure is reported" })
  bulkEdit(@Body(new ZodValidationPipe(bulkEditMovieSchema)) body: z.infer<typeof bulkEditMovieSchema>) {
    const { ids, ...patch } = body;
    return this.movies.bulkEdit(ids, patch);
  }

  @Post("bulk-tags")
  @ApiOperation({ summary: "Bulk-set tags on selected movies (UNI-020): add/remove/replace; empty tagIds clears on replace" })
  bulkTags(@Body(new ZodValidationPipe(bulkTagsSchema)) body: { ids: string[]; tagIds: string[]; mode: "add" | "remove" | "replace" }) {
    return this.movies.bulkTags(body.ids, body.tagIds, body.mode);
  }

  @Post("bulk-delete")
  @ApiOperation({ summary: "Remove selected movies (UNI-020): per-id success/failure; opt-in deleteFiles/addImportExclusion forwarded per item" })
  bulkDelete(@Body(new ZodValidationPipe(bulkDeleteMovieSchema)) body: { ids: string[]; deleteFiles?: boolean; addImportExclusion?: boolean }) {
    return this.movies.bulkDelete(body.ids, { deleteFiles: body.deleteFiles, addImportExclusion: body.addImportExclusion });
  }

  @Post("bulk-rename")
  @ApiOperation({ summary: "Rename files of selected movies (UNI-027): already-correct files are ignored; per-title failures aggregated" })
  bulkRename(@Body(new ZodValidationPipe(bulkRenameSchema)) body: { ids: string[] }) {
    return this.movies.bulkRename(body.ids);
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
