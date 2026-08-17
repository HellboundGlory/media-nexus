// SPDX-License-Identifier: MIT
import { Body, Controller, Delete, Get, Param, Post, Put } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { createDownloadClientSchema, updateDownloadClientSchema, testDownloadClientDraftSchema, type CreateDownloadClient, type TestDownloadClientDraft, type UpdateDownloadClientBody } from "@medianexus/domain";
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

  @Put(":id")
  @ApiOperation({ summary: "Edit a download client (credentials re-encrypted at rest; [REDACTED] means unchanged)" })
  update(@Param("id") id: string, @Body(new ZodValidationPipe(updateDownloadClientSchema)) body: UpdateDownloadClientBody) {
    return this.clients.update(id, body);
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

  @Post("test")
  @ApiOperation({ summary: "Health-check a download client draft config (no persistence)" })
  testDraft(@Body(new ZodValidationPipe(testDownloadClientDraftSchema)) body: TestDownloadClientDraft) {
    return this.clients.testDraft(body);
  }

  @Post("refresh-all")
  @ApiOperation({ summary: "Health-check every enabled download client" })
  refreshAll() {
    return this.clients.refreshAll();
  }
}
