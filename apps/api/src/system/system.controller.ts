// SPDX-License-Identifier: MIT
import { Body, Controller, Get, Put } from "@nestjs/common";
import { ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { ApiError, runtimeSettingsSchema } from "@medianexus/shared";
import { ZodValidationPipe } from "../common/zod.pipe";
import { SystemStatusService } from "./system-status.service";
import { ConfigService } from "./config.service";

const upsertSchema = z.record(z.string(), z.unknown());

@ApiTags("system")
@Controller("api/v1/system")
export class SystemController {
  constructor(
    private readonly statusSvc: SystemStatusService,
    private readonly configSvc: ConfigService,
  ) {}

  @Get("status")
  @ApiOperation({ summary: "Application status" })
  status() {
    return this.statusSvc.status();
  }

  @Get("config")
  @ApiOperation({ summary: "Global settings (admin)" })
  async getConfig() {
    return this.configSvc.get();
  }

  @Put("config")
  @ApiOperation({ summary: "Update global settings (admin)" })
  @ApiBody({ schema: { type: "object", additionalProperties: true } })
  async putConfig(@Body(new ZodValidationPipe(upsertSchema)) body: Record<string, unknown>) {
    const allowedKeys = new Set(Object.keys(runtimeSettingsSchema.shape));
    const unknownKeys = Object.keys(body).filter((k) => !allowedKeys.has(k));
    if (unknownKeys.length > 0) {
      throw new ApiError({ code: "VALIDATION_ERROR", message: `Unknown setting keys: ${unknownKeys.join(", ")}` });
    }
    return this.configSvc.upsert(body as never);
  }
}
