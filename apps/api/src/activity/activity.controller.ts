// SPDX-License-Identifier: MIT
import { Body, Controller, Delete, Get, Inject, Param, Post, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { and, desc, eq } from "drizzle-orm";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import { z } from "zod";
import { ZodValidationPipe } from "../common/zod.pipe";
import { ActivityService } from "./activity.service";
import { AcquisitionService } from "../acquisition/acquisition.service";

const historyQuery = z.object({
  mediaType: z.enum(["movie", "series"]).optional(),
  mediaId: z.string().optional(),
  action: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

const queueQuery = z.object({ mediaType: z.enum(["movie", "series"]).optional() });

const bulkRemoveBody = z.object({ ids: z.array(z.string().min(1)).min(1) });
// eslint-disable-next-line no-useless-assignment  -- referenced only inside a NestJS decorator; ESLint 10 doesn't count decorator usage
const manualImportBody = z.object({ path: z.string().min(1).optional() });

@ApiTags("activity")
@Controller("api/v1")
export class ActivityController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly activity: ActivityService,
    private readonly acquisition: AcquisitionService,
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

  @Post("queue/bulk-remove")
  @ApiOperation({ summary: "Remove multiple queue entries at once" })
  async bulkRemoveQueue(@Body(new ZodValidationPipe(bulkRemoveBody)) body: { ids: string[] }) {
    return this.activity.bulkRemoveQueue(body.ids);
  }

  @Post("history/bulk-remove")
  @ApiOperation({ summary: "Delete multiple history entries at once" })
  async bulkRemoveHistory(@Body(new ZodValidationPipe(bulkRemoveBody)) body: { ids: string[] }) {
    return this.activity.bulkRemoveHistory(body.ids);
  }

  @Post("queue/:id/retry")
  @ApiOperation({ summary: "Re-attempt import of a failed queue entry (re-arms it; never blocklists)" })
  async retryQueueEntry(@Param("id") id: string) {
    return this.acquisition.retryQueueEntry(id);
  }

  @Post("queue/:id/manual-import")
  @ApiOperation({ summary: "Import a queue entry, optionally from an explicit file/folder path" })
  async manualImportQueueEntry(@Param("id") id: string, @Body(new ZodValidationPipe(manualImportBody)) body: { path?: string }) {
    return this.acquisition.manualImportQueueEntry(id, body);
  }
}
