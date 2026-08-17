// SPDX-License-Identifier: MIT
import { Body, Controller, Delete, Get, Param, Post, Put } from "@nestjs/common";
import { ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import {
  customFormatSchema, updateCustomFormatSchema,
  type CustomFormatBody, type UpdateCustomFormatBody, type UpstreamCustomFormat,
} from "@medianexus/domain";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CustomFormatsService } from "./custom-formats.service";

// Upstream CustomFormatResource wire shape (SON-025 Phase 4 / UNI-025) — validated loosely
// before the import mapper does its per-condition work (which reports unsupported types).
const upstreamSpecSchema = z.object({
  name: z.string().optional(),
  implementation: z.string().min(1),
  negate: z.boolean().optional(),
  required: z.boolean().optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
});
const upstreamFormatSchema = z.object({
  name: z.string().min(1),
  includeCustomFormatWhenRenaming: z.boolean().optional(),
  specifications: z.array(upstreamSpecSchema).default([]),
});

@ApiTags("custom-formats")
@Controller("api/v1")
export class CustomFormatsController {
  constructor(private readonly formats: CustomFormatsService) {}

  @Get("custom-formats")
  @ApiOperation({ summary: "List custom formats" })
  list() {
    return this.formats.list();
  }

  @Get("custom-formats/:id")
  @ApiOperation({ summary: "Get a custom format" })
  get(@Param("id") id: string) {
    return this.formats.get(id);
  }

  @Get("custom-formats/:id/export")
  @ApiOperation({ summary: "Serialize a custom format to the Sonarr/Radarr export JSON shape" })
  async exportFmt(@Param("id") id: string) {
    return this.formats.exportFormat(id);
  }

  @Post("custom-formats/import")
  @ApiOperation({ summary: "Import a custom format from the Sonarr/Radarr export JSON shape. Unsupported conditions are reported per-condition, never silently dropped." })
  @ApiBody({ schema: { type: "object", properties: { name: { type: "string" }, specifications: { type: "array" } } } })
  async importFmt(@Body(new ZodValidationPipe(upstreamFormatSchema)) body: UpstreamCustomFormat) {
    return this.formats.importFormat(body);
  }

  @Post("custom-formats")
  @ApiOperation({ summary: "Create a custom format (name + release-matching specs)" })
  create(@Body(new ZodValidationPipe(customFormatSchema)) body: CustomFormatBody) {
    return this.formats.create(body);
  }

  @Put("custom-formats/:id")
  @ApiOperation({ summary: "Update a custom format" })
  update(@Param("id") id: string, @Body(new ZodValidationPipe(updateCustomFormatSchema)) body: UpdateCustomFormatBody) {
    return this.formats.update(id, body);
  }

  @Delete("custom-formats/:id")
  @ApiOperation({ summary: "Delete a custom format" })
  remove(@Param("id") id: string) {
    return this.formats.remove(id);
  }
}
