// SPDX-License-Identifier: MIT
import { Controller, Delete, Get, Inject, Param, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { and, desc, eq } from "drizzle-orm";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import { z } from "zod";
import { ZodValidationPipe } from "../common/zod.pipe";
import { ActivityService } from "./activity.service";

const historyQuery = z.object({
  mediaType: z.enum(["movie", "series"]).optional(),
  mediaId: z.string().optional(),
  action: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

const queueQuery = z.object({ mediaType: z.enum(["movie", "series"]).optional() });

@ApiTags("activity")
@Controller("api/v1")
export class ActivityController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly activity: ActivityService,
  ) {}

  @Get("history")
  @ApiOperation({ summary: "Unified activity history (movies + series)" })
  async history(@Query(new ZodValidationPipe(historyQuery)) q: z.infer<typeof historyQuery>) {
    const conds = [];
    if (q.mediaType) conds.push(eq(schema.historyEntry.mediaType, q.mediaType));
    if (q.mediaId) conds.push(eq(schema.historyEntry.mediaId, q.mediaId));
    if (q.action) conds.push(eq(schema.historyEntry.action, q.action));
    const rows = await this.db.select().from(schema.historyEntry)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(schema.historyEntry.createdAt)).limit(q.limit);
    return { items: rows, total: rows.length };
  }

  @Get("queue")
  @ApiOperation({ summary: "Download queue (unified)" })
  async queue(@Query(new ZodValidationPipe(queueQuery)) q: z.infer<typeof queueQuery>) {
    const conds = [];
    if (q.mediaType) conds.push(eq(schema.downloadQueueEntry.mediaType, q.mediaType));
    const rows = await this.db.select().from(schema.downloadQueueEntry)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(schema.downloadQueueEntry.addedAt));
    return { items: rows, total: rows.length };
  }

  @Delete("queue/:id")
  @ApiOperation({ summary: "Clear a stuck queue entry (does not delete client-side data)" })
  async removeQueueEntry(@Param("id") id: string) {
    return this.activity.removeQueueEntry(id);
  }
}
