// SPDX-License-Identifier: MIT
import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import {
  createIndexerSchema, updateIndexerSchema, grabRequestSchema, testIndexerDraftSchema,
  type CreateIndexer, type GrabRequest, type TestIndexerDraft, type UpdateIndexerBody,
} from "@medianexus/domain";
import { ZodValidationPipe } from "../common/zod.pipe";
import { IndexersService } from "./indexers.service";
import { RateLimitGuard } from "../common/rate-limit.guard";

const createDefinitionBody = z.object({
  key: z.string().regex(/^[a-z0-9_-]+$/, "key must be lowercase alphanumeric + -/_"),
  name: z.string().min(1),
  protocol: z.enum(["usenet", "torrent"]),
  cardigannYml: z.string().min(10),
});

const searchSchema = z.object({
  mediaType: z.enum(["movie", "series"]),
  mediaId: z.string(),
  query: z.string().optional(),
  seasons: z.array(z.number().int().min(0)).optional(),
  episodes: z.array(z.number().int().min(1)).optional(),
});

@ApiTags("indexers")
@Controller("api/v1")
export class IndexersController {
  constructor(private readonly indexers: IndexersService) {}

  @Get("indexers/definitions")
  @ApiOperation({ summary: "Catalog of known indexer definitions" })
  definitions() {
    return this.indexers.definitions();
  }

  @Get("indexers")
  @ApiOperation({ summary: "Configured indexers" })
  list() {
    return this.indexers.list();
  }

  @Post("indexers")
  @ApiOperation({ summary: "Configure an indexer (newznab/torznab/memory/cardigann)" })
  create(@Body(new ZodValidationPipe(createIndexerSchema)) body: CreateIndexer) {
    return this.indexers.create(body);
  }

  @Post("indexers/refresh-all")
  @ApiOperation({ summary: "Health-check every enabled indexer" })
  refreshAll() {
    return this.indexers.refreshAll();
  }

  @Put("indexers/:id")
  @ApiOperation({ summary: "Edit an indexer (credentials re-encrypted at rest; [REDACTED] means unchanged)" })
  update(@Param("id") id: string, @Body(new ZodValidationPipe(updateIndexerSchema)) body: UpdateIndexerBody) {
    return this.indexers.update(id, body);
  }

  @Post("indexers/:id/test")
  @ApiOperation({ summary: "Health-check an indexer and persist the result" })
  test(@Param("id") id: string) {
    return this.indexers.test(id);
  }

  @Post("indexers/test")
  @ApiOperation({ summary: "Health-check an indexer draft config (no persistence)" })
  testDraft(@Body(new ZodValidationPipe(testIndexerDraftSchema)) body: TestIndexerDraft) {
    return this.indexers.testDraft(body);
  }

  @Get("indexers/statistics")
  @ApiOperation({ summary: "Per-indexer grab statistics" })
  statistics() {
    return this.indexers.statistics();
  }

  @Post("indexers/definitions")
  @ApiOperation({ summary: "Create a custom Cardigann definition" })
  createDefinition(@Body(new ZodValidationPipe(createDefinitionBody)) body: z.infer<typeof createDefinitionBody>) {
    return this.indexers.createDefinition(body);
  }

  @Delete("indexers/:id")
  @ApiOperation({ summary: "Remove an indexer" })
  remove(@Param("id") id: string) {
    return this.indexers.remove(id);
  }

  @Post("search")
  @ApiOperation({ summary: "Search configured indexers for a title (M1: real providers)" })
  search(@Body(new ZodValidationPipe(searchSchema)) body: z.infer<typeof searchSchema>) {
    return this.indexers.search(body);
  }

  @Post("grabs")
  @UseGuards(RateLimitGuard)
  @ApiOperation({ summary: "Grab a release into a download client" })
  grab(@Body(new ZodValidationPipe(grabRequestSchema)) body: GrabRequest) {
    return this.indexers.grab(body);
  }
}
