// SPDX-License-Identifier: MIT
import { Body, Controller, Get, Param, Post, Put } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CollectionsService, type UpdateCollectionBody, type AddPartOverrides } from "./collections.service";

const minimumAvailability = z.enum(["announced", "in_cinemas", "released", "deleted"]);

// Every field optional, omitted = unchanged (same "No Change" sentinel as updateMovieSchema).
const updateCollectionSchema = z.object({
  monitored: z.boolean().optional(),
  qualityProfileId: z.string().nullable().optional(),
  rootFolderPath: z.string().optional(),
  minimumAvailability: minimumAvailability.optional(),
  searchOnAdd: z.boolean().optional(),
});

const bulkEditSchema = updateCollectionSchema.extend({
  ids: z.array(z.string()).min(1, "select at least one collection"),
});

// Per-part add overrides from AddTitleModal (COLLECTADD-1). Every field optional + the whole body
// defaults to {} so an absent body keeps the previous behaviour (collection's saved settings).
// The schema is referenced only inside the @Body decorator below; ESLint 10's
// no-useless-assignment doesn't count decorator usage (same as audit.controller.ts).
// eslint-disable-next-line no-useless-assignment
const addPartSchema = z.object({
  monitored: z.boolean().optional(),
  qualityProfileId: z.string().nullable().optional(),
  rootFolderPath: z.string().optional(),
  minimumAvailability: minimumAvailability.optional(),
  tags: z.array(z.string()).optional(),
}).default({});

@ApiTags("collections")
@Controller("api/v1/collections")
export class CollectionsController {
  constructor(private readonly collections: CollectionsService) {}

  @Get()
  @ApiOperation({ summary: "List collections (each with a computed missing-count)" })
  list() {
    return this.collections.list();
  }

  @Put(":id")
  @ApiOperation({ summary: "Edit a collection (Monitor toggles owned-movie monitoring immediately)" })
  update(@Param("id") id: string, @Body(new ZodValidationPipe(updateCollectionSchema)) body: UpdateCollectionBody) {
    return this.collections.update(id, body);
  }

  @Post("bulk-edit")
  @ApiOperation({ summary: "Bulk-edit selected collections (No Change fields omitted per item)" })
  bulkEdit(@Body(new ZodValidationPipe(bulkEditSchema)) body: { ids: string[] } & UpdateCollectionBody) {
    const { ids, ...patch } = body;
    return this.collections.bulkEdit(ids, patch);
  }

  @Post(":id/sync")
  @ApiOperation({ summary: "Manually sync a collection (refresh parts; auto-add missing when monitored)" })
  sync(@Param("id") id: string) {
    return this.collections.sync(id);
  }

  @Post(":id/parts/:tmdbId/add")
  @ApiOperation({ summary: "Add one missing part to a collection with optional overrides, then re-sync it" })
  addPart(
    @Param("id") id: string,
    @Param("tmdbId") tmdbId: string,
    @Body(new ZodValidationPipe(addPartSchema)) body: AddPartOverrides,
  ) {
    return this.collections.addPart(id, Number(tmdbId), body);
  }
}
