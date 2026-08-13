// SPDX-License-Identifier: MIT
import { Body, Controller, Delete, Get, Param, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { createRootFolderSchema, type CreateRootFolder } from "@medianexus/domain";
import { ZodValidationPipe } from "../common/zod.pipe";
import { RootFoldersService } from "./root-folders.service";

@ApiTags("root-folders")
@Controller("api/v1/root-folders")
export class RootFoldersController {
  constructor(private readonly rootFolders: RootFoldersService) {}

  @Get()
  @ApiOperation({ summary: "List root folders with live accessibility and free space" })
  list() {
    return this.rootFolders.list();
  }

  @Get(":id")
  @ApiOperation({ summary: "Get a root folder" })
  get(@Param("id") id: string) {
    return this.rootFolders.get(id);
  }

  @Post()
  @ApiOperation({ summary: "Add a root folder (path must already exist on disk)" })
  create(@Body(new ZodValidationPipe(createRootFolderSchema)) body: CreateRootFolder) {
    return this.rootFolders.create(body);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Remove a root folder (rejected if a movie or series is assigned to it)" })
  remove(@Param("id") id: string) {
    return this.rootFolders.remove(id);
  }
}
