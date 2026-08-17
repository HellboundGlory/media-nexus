// SPDX-License-Identifier: MIT
import { Body, Controller, Delete, Get, Param, Post, Put, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { createSeriesSchema, updateSeriesSchema, type CreateSeries, type UpdateSeriesBody } from "@medianexus/domain";
import { ZodValidationPipe } from "../common/zod.pipe";
import { SeriesService } from "./series.service";
import { LibraryScanService } from "../library-scan/library-scan.service";

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

const deleteSeriesSchema = z.object({
  deleteFiles: z.boolean().optional(),
  addImportExclusion: z.boolean().optional(),
}).default({});

const renameBodySchema = z.object({ mediaFileIds: z.array(z.string()).default([]) });

const manageApplyBodySchema = z.object({
  removeStale: z.array(z.string()).default([]),
  importUntracked: z.array(z.string()).default([]),
});

// ---- Bulk actions (UNI-020): fan out over existing single-item update()/remove(). Reuses
// updateSeriesSchema's all-optional "No Change" patch via .pick() — title/folderName/tags are
// excluded (tags has its own endpoint; title/folderName bulk-editing makes no sense).
const bulkEditSeriesSchema = updateSeriesSchema.pick({
  monitored: true,
  qualityProfileId: true,
  rootFolderPath: true,
  seriesType: true,
}).extend({ ids: z.array(z.string()).min(1, "select at least one series") });

const bulkTagsSchema = z.object({
  ids: z.array(z.string()).min(1, "select at least one series"),
  tagIds: z.array(z.string()).default([]),
  mode: z.enum(["add", "remove", "replace"]),
});

const bulkDeleteSeriesSchema = z.object({
  ids: z.array(z.string()).min(1, "select at least one series"),
  deleteFiles: z.boolean().optional(),
  addImportExclusion: z.boolean().optional(),
});

@ApiTags("series")
@Controller("api/v1/series")
export class SeriesController {
  constructor(
    private readonly series: SeriesService,
    private readonly scan: LibraryScanService,
  ) {}

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

  @Post("bulk-edit")
  @ApiOperation({ summary: "Bulk-edit selected series (UNI-020): only fields present are applied per item; per-id success/failure is reported" })
  bulkEdit(@Body(new ZodValidationPipe(bulkEditSeriesSchema)) body: z.infer<typeof bulkEditSeriesSchema>) {
    const { ids, ...patch } = body;
    return this.series.bulkEdit(ids, patch);
  }

  @Post("bulk-tags")
  @ApiOperation({ summary: "Bulk-set tags on selected series (UNI-020): add/remove/replace; empty tagIds clears on replace" })
  bulkTags(@Body(new ZodValidationPipe(bulkTagsSchema)) body: { ids: string[]; tagIds: string[]; mode: "add" | "remove" | "replace" }) {
    return this.series.bulkTags(body.ids, body.tagIds, body.mode);
  }

  @Post("bulk-delete")
  @ApiOperation({ summary: "Remove selected series (UNI-020): per-id success/failure; opt-in deleteFiles/addImportExclusion forwarded per item" })
  bulkDelete(@Body(new ZodValidationPipe(bulkDeleteSeriesSchema)) body: { ids: string[]; deleteFiles?: boolean; addImportExclusion?: boolean }) {
    return this.series.bulkDelete(body.ids, { deleteFiles: body.deleteFiles, addImportExclusion: body.addImportExclusion });
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
  @ApiOperation({ summary: "Remove a series (opt-in: deleteFiles disposes files+folder, addImportExclusion adds a list-exclusion row)" })
  remove(@Param("id") id: string, @Body(new ZodValidationPipe(deleteSeriesSchema)) body: { deleteFiles?: boolean; addImportExclusion?: boolean }) {
    return this.series.remove(id, body);
  }

  @Get(":id/episodes")
  @ApiOperation({ summary: "Episodes of a series (optional season filter)" })
  episodes(@Param("id") id: string, @Query(new ZodValidationPipe(episodesQuery)) q: { season?: number }) {
    return this.series.episodes(id, q.season);
  }

  @Get(":id/credits")
  @ApiOperation({ summary: "Cast & crew of a series" })
  credits(@Param("id") id: string) {
    return this.series.credits(id);
  }

  @Get(":id/rename-preview")
  @ApiOperation({ summary: "Read-only preview of a rename under the current naming template (optional ?season=N scopes to one season)" })
  renamePreview(@Param("id") id: string, @Query(new ZodValidationPipe(episodesQuery)) q: { season?: number }) {
    return this.series.renamePreview(id, q.season);
  }

  @Post(":id/rename")
  @ApiOperation({ summary: "Execute a rename: move the requested files on disk and update their paths (optional ?season=N scopes the candidate set to one season)" })
  rename(@Param("id") id: string, @Query(new ZodValidationPipe(episodesQuery)) q: { season?: number }, @Body(new ZodValidationPipe(renameBodySchema)) body: { mediaFileIds: string[] }) {
    return this.series.rename(id, body.mediaFileIds, q.season);
  }

  @Get(":id/files")
  @ApiOperation({ summary: "Media files of a series" })
  files(@Param("id") id: string) {
    return this.series.files(id);
  }

  @Get(":id/manage-files")
  @ApiOperation({ summary: "Scan-preview a series' folder: untracked episodes on disk vs stale rows (optional ?season=N scopes to one season)" })
  managePreview(@Param("id") id: string, @Query(new ZodValidationPipe(episodesQuery)) q: { season?: number }) {
    return this.scan.previewSeries(id, q.season);
  }

  @Post(":id/manage-files/apply")
  @ApiOperation({ summary: "Apply the user's Manage Episodes selection: import the checked untracked episodes and remove the checked stale rows (only what's ticked; optional ?season=N scopes to one season)" })
  manageApply(@Param("id") id: string, @Query(new ZodValidationPipe(episodesQuery)) q: { season?: number }, @Body(new ZodValidationPipe(manageApplyBodySchema)) body: { removeStale: string[]; importUntracked: string[] }) {
    return this.scan.applySeries(id, body, q.season);
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

  @Post(":id/episodes/:episodeId/auto-search")
  @ApiOperation({ summary: "Search indexers for an episode and auto-grab the best release (one click)" })
  autoSearchEpisode(@Param("id") id: string, @Param("episodeId") episodeId: string) {
    return this.series.autoSearchEpisode(id, episodeId);
  }

  @Post(":id/seasons/:seasonNumber/auto-search")
  @ApiOperation({ summary: "Search indexers for every missing episode in a season and auto-grab the best release for each (one click)" })
  autoSearchSeason(@Param("id") id: string, @Param("seasonNumber") seasonNumber: string) {
    return this.series.autoSearchSeason(id, Number(seasonNumber));
  }
}
