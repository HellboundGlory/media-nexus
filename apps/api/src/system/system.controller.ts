// SPDX-License-Identifier: MIT
import { Body, Controller, Get, Put } from "@nestjs/common";
import { ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { ApiError, runtimeSettingsSchema } from "@medianexus/shared";
import { UseGuards } from "@nestjs/common";
import { ZodValidationPipe } from "../common/zod.pipe";
import { redactDeep } from "../common/redact";
import { AdminGuard } from "../common/admin.guard";
import { SystemStatusService } from "./system-status.service";
import { ConfigService } from "./config.service";

// eslint-disable-next-line no-useless-assignment  -- referenced only inside a NestJS decorator; ESLint 10 doesn't count decorator usage
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
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: "Global settings (admin; credentials masked)" })
  async getConfig() {
    return redactDeep(await this.configSvc.get()) as never;
  }

  @Put("config")
  @UseGuards(AdminGuard)
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
