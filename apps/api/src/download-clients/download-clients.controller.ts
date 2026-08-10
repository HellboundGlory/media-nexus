// SPDX-License-Identifier: MIT
import { Body, Controller, Delete, Get, Param, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { createDownloadClientSchema, type CreateDownloadClient } from "@medianexus/domain";
import { ZodValidationPipe } from "../common/zod.pipe";
import { DownloadClientsService } from "./download-clients.service";

@ApiTags("download-clients")
@Controller("api/v1/download-clients")
export class DownloadClientsController {
  constructor(private readonly clients: DownloadClientsService) {}

  @Get()
  @ApiOperation({ summary: "Configured download clients" })
  list() {
    return this.clients.list();
  }

  @Post()
  @ApiOperation({ summary: "Add a download client (sabnzbd | qbittorrent | memory)" })
  create(@Body(new ZodValidationPipe(createDownloadClientSchema)) body: CreateDownloadClient) {
    return this.clients.create(body);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Remove a download client" })
  remove(@Param("id") id: string) {
    return this.clients.remove(id);
  }

  @Post(":id/test")
  @ApiOperation({ summary: "Health-check a download client" })
  test(@Param("id") id: string) {
    return this.clients.test(id);
  }
}
