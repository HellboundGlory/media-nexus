// SPDX-License-Identifier: MIT
import { Body, Controller, Delete, Get, Param, Post, Put } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { createTagSchema, updateTagSchema, type CreateTag, type UpdateTag } from "@medianexus/domain";
import { ZodValidationPipe } from "../common/zod.pipe";
import { TagsService } from "./tags.service";

@ApiTags("tags")
@Controller("api/v1/tags")
export class TagsController {
  constructor(private readonly tags: TagsService) {}

  @Get()
  @ApiOperation({ summary: "List tags" })
  list() {
    return this.tags.list();
  }

  @Post()
  @ApiOperation({ summary: "Create a tag" })
  create(@Body(new ZodValidationPipe(createTagSchema)) body: CreateTag) {
    return this.tags.create(body);
  }

  @Put(":id")
  @ApiOperation({ summary: "Update a tag's label/color" })
  update(@Param("id") id: string, @Body(new ZodValidationPipe(updateTagSchema)) body: UpdateTag) {
    return this.tags.update(id, body);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Delete a tag and strip it from any entity using it" })
  remove(@Param("id") id: string) {
    return this.tags.remove(id);
  }
}
