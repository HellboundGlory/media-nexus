// SPDX-License-Identifier: MIT
import { Body, Controller, Delete, Get, Param, Post, Put } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  autoTagSchema, updateAutoTagSchema, type AutoTagBody, type UpdateAutoTagBody,
} from "@medianexus/domain";
import { ZodValidationPipe } from "../common/zod.pipe";
import { AutoTagsService } from "./auto-tags.service";

@ApiTags("auto-tags")
@Controller("api/v1")
export class AutoTagsController {
  constructor(private readonly autoTags: AutoTagsService) {}

  @Get("auto-tags")
  @ApiOperation({ summary: "List auto-tag rules" })
  list() {
    return this.autoTags.list();
  }

  @Get("auto-tags/:id")
  @ApiOperation({ summary: "Get an auto-tag rule" })
  get(@Param("id") id: string) {
    return this.autoTags.get(id);
  }

  @Post("auto-tags")
  @ApiOperation({ summary: "Create an auto-tag rule (typed specifications that add/remove tags on matching media)" })
  create(@Body(new ZodValidationPipe(autoTagSchema)) body: AutoTagBody) {
    return this.autoTags.create(body);
  }

  @Put("auto-tags/:id")
  @ApiOperation({ summary: "Update an auto-tag rule" })
  update(@Param("id") id: string, @Body(new ZodValidationPipe(updateAutoTagSchema)) body: UpdateAutoTagBody) {
    return this.autoTags.update(id, body);
  }

  @Delete("auto-tags/:id")
  @ApiOperation({ summary: "Delete an auto-tag rule" })
  remove(@Param("id") id: string) {
    return this.autoTags.remove(id);
  }
}
