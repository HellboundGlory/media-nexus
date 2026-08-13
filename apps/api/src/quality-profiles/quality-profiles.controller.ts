// SPDX-License-Identifier: MIT
import { Body, Controller, Delete, Get, Param, Post, Put } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  qualityProfileSchema, updateQualityProfileSchema,
  type QualityProfileBody, type UpdateQualityProfileBody,
} from "@medianexus/domain";
import { ZodValidationPipe } from "../common/zod.pipe";
import { QualityProfilesService } from "./quality-profiles.service";

@ApiTags("quality-profiles")
@Controller("api/v1")
export class QualityProfilesController {
  constructor(private readonly profiles: QualityProfilesService) {}

  @Get("quality-profiles/registry")
  @ApiOperation({ summary: "Static ordered quality registry (ids, titles, source/resolution)" })
  registry() {
    return this.profiles.registry();
  }

  @Get("quality-definitions")
  @ApiOperation({ summary: "Per-quality size limits (min/max/preferred)" })
  definitions() {
    return this.profiles.definitions();
  }

  @Get("quality-profiles")
  @ApiOperation({ summary: "List quality profiles" })
  list() {
    return this.profiles.list();
  }

  @Get("quality-profiles/:id")
  @ApiOperation({ summary: "Get a quality profile" })
  get(@Param("id") id: string) {
    return this.profiles.get(id);
  }

  @Post("quality-profiles")
  @ApiOperation({ summary: "Create a quality profile" })
  create(@Body(new ZodValidationPipe(qualityProfileSchema)) body: QualityProfileBody) {
    return this.profiles.create(body);
  }

  @Put("quality-profiles/:id")
  @ApiOperation({ summary: "Update a quality profile" })
  update(@Param("id") id: string, @Body(new ZodValidationPipe(updateQualityProfileSchema)) body: UpdateQualityProfileBody) {
    return this.profiles.update(id, body);
  }

  @Delete("quality-profiles/:id")
  @ApiOperation({ summary: "Delete a quality profile (rejected if a movie or series still references it)" })
  remove(@Param("id") id: string) {
    return this.profiles.remove(id);
  }
}
