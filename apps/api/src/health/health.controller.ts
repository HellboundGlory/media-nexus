// SPDX-License-Identifier: MIT
import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { sql } from "drizzle-orm";
import { Public } from "../common/public.decorator";
import { DB_TOKEN } from "../db/database.module";
import { schema as dbSchema, type Db } from "@medianexus/database";

@ApiTags("health")
@Controller("health")
export class HealthController {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  @Get("live")
  @Public()
  @ApiOperation({ summary: "Liveness: process is up" })
  live() {
    return { status: "ok", uptimeSeconds: Math.round(process.uptime()) };
  }

  @Get("ready")
  @Public()
  @ApiOperation({ summary: "Readiness: database reachable + migrations applied" })
  async ready() {
    try {
      await this.db.select({ one: sql`1` }).from(dbSchema.setting).limit(1);
      return { status: "ok", db: "up" };
    } catch (err) {
      throw new ServiceUnavailableException({ status: "error", db: "down", message: (err as Error).message });
    }
  }
}
