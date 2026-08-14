// SPDX-License-Identifier: MIT
import { Body, Controller, Delete, Get, Param, Post, Put } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  customFormatSchema, updateCustomFormatSchema,
  type CustomFormatBody, type UpdateCustomFormatBody,
} from "@medianexus/domain";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CustomFormatsService } from "./custom-formats.service";

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
