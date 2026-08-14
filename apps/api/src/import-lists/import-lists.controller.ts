// SPDX-License-Identifier: MIT
import { Body, Controller, Delete, Get, Param, Post, Put } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  createImportExclusionSchema, createImportListSchema, updateImportListSchema,
  type CreateImportExclusion, type CreateImportList, type UpdateImportList,
} from "@medianexus/domain";
import { ZodValidationPipe } from "../common/zod.pipe";
import { ImportListsService } from "./import-lists.service";

@ApiTags("import-lists")
@Controller("api/v1/import-lists")
export class ImportListsController {
  constructor(private readonly importLists: ImportListsService) {}

  @Get()
  @ApiOperation({ summary: "List configured import lists" })
  list() {
    return this.importLists.list();
  }

  @Post()
  @ApiOperation({ summary: "Add an import list (watchlist source)" })
  create(@Body(new ZodValidationPipe(createImportListSchema)) body: CreateImportList) {
    return this.importLists.create(body);
  }

  @Put(":id")
  @ApiOperation({ summary: "Edit an import list" })
  update(@Param("id") id: string, @Body(new ZodValidationPipe(updateImportListSchema)) body: UpdateImportList) {
    return this.importLists.update(id, body);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Remove an import list" })
  remove(@Param("id") id: string) {
    return this.importLists.remove(id);
  }

  @Post(":id/grab")
  @ApiOperation({ summary: "Run a one-off sync of an import list" })
  grab(@Param("id") id: string) {
    return this.importLists.syncList(id);
  }

  @Get("exclusions")
  @ApiOperation({ summary: "List import exclusions (titles never re-added)" })
  listExclusions() {
    return this.importLists.listExclusions();
  }

  @Post("exclusions")
  @ApiOperation({ summary: "Add an import exclusion (don't re-add this title)" })
  addExclusion(@Body(new ZodValidationPipe(createImportExclusionSchema)) body: CreateImportExclusion) {
    return this.importLists.addExclusion(body);
  }

  @Delete("exclusions/:id")
  @ApiOperation({ summary: "Clear an import exclusion (allow re-add)" })
  removeExclusion(@Param("id") id: string) {
    return this.importLists.removeExclusion(id);
  }
}
