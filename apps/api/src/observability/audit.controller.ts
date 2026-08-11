// SPDX-License-Identifier: MIT
import { Controller, Get, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Inject } from "@nestjs/common";
import { desc } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import { ZodValidationPipe } from "../common/zod.pipe";

// eslint-disable-next-line no-useless-assignment  -- referenced only inside a NestJS decorator; ESLint 10 doesn't count decorator usage
const auditQuery = z.object({ limit: z.coerce.number().int().positive().max(500).default(100) });

@ApiTags("system")
@Controller("api/v1/system")
export class AuditController {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  @Get("audit")
  @ApiOperation({ summary: "Recent audit-log entries (admin actions, events)" })
  audit(@Query(new ZodValidationPipe(auditQuery)) q: { limit: number }) {
    return this.db.select().from(schema.auditLog).orderBy(desc(schema.auditLog.createdAt)).limit(q.limit);
  }
}
