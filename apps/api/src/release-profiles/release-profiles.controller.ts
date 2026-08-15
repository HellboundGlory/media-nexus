// SPDX-License-Identifier: MIT
import { Body, Controller, Delete, Get, Param, Post, Put } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  releaseProfileSchema, updateReleaseProfileSchema,
  type ReleaseProfileBody, type UpdateReleaseProfileBody,
} from "@medianexus/domain";
import { ZodValidationPipe } from "../common/zod.pipe";
import { ReleaseProfilesService } from "./release-profiles.service";

@ApiTags("release-profiles")
@Controller("api/v1")
export class ReleaseProfilesController {
  constructor(private readonly profiles: ReleaseProfilesService) {}

  @Get("release-profiles")
  @ApiOperation({ summary: "List release profiles" })
  list() {
    return this.profiles.list();
  }

  @Get("release-profiles/:id")
  @ApiOperation({ summary: "Get a release profile" })
  get(@Param("id") id: string) {
    return this.profiles.get(id);
  }

  @Post("release-profiles")
  @ApiOperation({ summary: "Create a release profile (tag-scoped Required/Ignored term restrictions)" })
  create(@Body(new ZodValidationPipe(releaseProfileSchema)) body: ReleaseProfileBody) {
    return this.profiles.create(body);
  }

  @Put("release-profiles/:id")
  @ApiOperation({ summary: "Update a release profile" })
  update(@Param("id") id: string, @Body(new ZodValidationPipe(updateReleaseProfileSchema)) body: UpdateReleaseProfileBody) {
    return this.profiles.update(id, body);
  }

  @Delete("release-profiles/:id")
  @ApiOperation({ summary: "Delete a release profile" })
  remove(@Param("id") id: string) {
    return this.profiles.remove(id);
  }
}
