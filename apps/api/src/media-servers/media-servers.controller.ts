// SPDX-License-Identifier: MIT
import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { ZodValidationPipe } from "../common/zod.pipe";
import { MediaServersService } from "./media-servers.service";
import { AdminGuard } from "../common/admin.guard";

const createBody = z.object({
  name: z.string().min(1),
  implementation: z.enum(["jellyfin", "plex"]),
  enabled: z.boolean().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});
const updateBody = z.object({
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

@ApiTags("media-servers")
@Controller("api/v1/media-servers")
export class MediaServersController {
  constructor(private readonly servers: MediaServersService) {}

  @Get()
  @ApiOperation({ summary: "Configured media servers" })
  list() { return this.servers.list(); }

  @UseGuards(AdminGuard)
  @Post()
  @ApiOperation({ summary: "Add a media server (admin)" })
  create(@Body(new ZodValidationPipe(createBody)) body: z.infer<typeof createBody>) {
    return this.servers.create(body);
  }

  @UseGuards(AdminGuard)
  @Put(":id")
  @ApiOperation({ summary: "Edit a media server ([REDACTED] apiKey means unchanged, admin)" })
  update(@Param("id") id: string, @Body(new ZodValidationPipe(updateBody)) body: z.infer<typeof updateBody>) {
    return this.servers.update(id, body);
  }

  @UseGuards(AdminGuard)
  @Delete(":id")
  @ApiOperation({ summary: "Remove a media server (admin)" })
  remove(@Param("id") id: string) {
    return this.servers.remove(id);
  }

  @Post("refresh")
  @ApiOperation({ summary: "Refresh availability from configured media servers" })
  refresh() { return this.servers.refreshAll(); }

  @UseGuards(AdminGuard)
  @Post(":id/test")
  @ApiOperation({ summary: "Health-check a configured media server" })
  test(@Param("id") id: string) { return this.servers.test(id); }
}
