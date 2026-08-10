// SPDX-License-Identifier: MIT
import { Body, Controller, Get, Param, Post, Put, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { ZodValidationPipe } from "../common/zod.pipe";
import { MediaServersService } from "./media-servers.service";
import type { MediaServerConfig } from "@medianexus/shared";
import { AdminGuard } from "./admin.guard";

const serversBody = z.object({ servers: z.array(z.any()).max(20) });

@ApiTags("media-servers")
@Controller("api/v1/media-servers")
export class MediaServersController {
  constructor(private readonly servers: MediaServersService) {}

  @Get()
  @ApiOperation({ summary: "Configured media servers (from config)" })
  list() { return this.servers.listConfigured(); }

  @UseGuards(AdminGuard)
  @Put()
  @ApiOperation({ summary: "Save media server configuration (admin)" })
  save(@Body(new ZodValidationPipe(serversBody)) body: { servers: MediaServerConfig[] }) {
    return this.servers.saveConfigured(body.servers);
  }

  @Post("refresh")
  @ApiOperation({ summary: "Refresh availability from configured media servers" })
  refresh() { return this.servers.refreshAll(); }

  @Post(":index/test")
  @ApiOperation({ summary: "Health-check a configured media server" })
  test(@Param("index") index: string) { return this.servers.testServer(Number(index)); }
}
