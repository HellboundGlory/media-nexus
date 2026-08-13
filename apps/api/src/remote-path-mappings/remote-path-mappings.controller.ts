// SPDX-License-Identifier: MIT
import { Body, Controller, Delete, Get, Param, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { createRemotePathMappingSchema, type CreateRemotePathMapping } from "@medianexus/domain";
import { ZodValidationPipe } from "../common/zod.pipe";
import { RemotePathMappingsService } from "./remote-path-mappings.service";

@ApiTags("remote-path-mappings")
@Controller("api/v1/remote-path-mappings")
export class RemotePathMappingsController {
  constructor(private readonly mappings: RemotePathMappingsService) {}

  @Get()
  @ApiOperation({ summary: "List remote path mappings" })
  list() {
    return this.mappings.list();
  }

  @Post()
  @ApiOperation({ summary: "Add a remote path mapping for a download client" })
  create(@Body(new ZodValidationPipe(createRemotePathMappingSchema)) body: CreateRemotePathMapping) {
    return this.mappings.create(body);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Remove a remote path mapping" })
  remove(@Param("id") id: string) {
    return this.mappings.remove(id);
  }
}
