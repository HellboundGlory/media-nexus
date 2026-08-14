// SPDX-License-Identifier: MIT
import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, lt, notInArray } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { schema, type Db } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import { ConfigService } from "./config.service";
import { TERMINAL_QUEUE_STATUSES } from "../acquisition/acquisition.service";

const TERMINAL_JOB_STATUSES = ["succeeded", "failed", "cancelled", "timed_out"] as const;

export interface HousekeepingSummary {
  orphansRemoved: { mediaFile: number; downloadQueueEntry: number; historyEntry: number; mediaAvailability: number; blocklistEntry: number };
  jobRunsTrimmed: number;
  auditLogTrimmed: number;
  queueEntriesTrimmed: number;
  blocklistTrimmed: number;
}

/**
 * Housekeeping (roadmap P1, gap report B9): nothing was ever cleaned up before this —
 * `job_run`, `audit_log`, terminal `download_queue_entry` rows and `blocklist_entry` all
 * grew unbounded (the last one is finding B6's own forward-reference: "expire entries via
 * housekeeping"). Runs as the `system.housekeeping` job, daily, replacing the dead
 * `system.metadataCleanup` seed row (migration 0011).
 *
 * Orphan sweep is defense-in-depth, not a fix for an active bug: `MoviesService.remove()`/
 * `SeriesService.remove()` already cascade the 5 polymorphic tables at the application
 * level inside the same transaction as the row delete (roadmap P0.7) — this only catches
 * a bypassed cascade or data that predates P0.7.
 */
@Injectable()
export class HousekeepingService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly config: ConfigService,
  ) {}

  async run(): Promise<HousekeepingSummary> {
    const cfg = await this.config.get();
    const now = Date.now();
    const jobRunCutoff = new Date(now - cfg["system.housekeeping.jobRunRetentionDays"] * 86_400_000).toISOString();
    const auditLogCutoff = new Date(now - cfg["system.housekeeping.auditLogRetentionDays"] * 86_400_000).toISOString();
    const queueCutoff = new Date(now - cfg["system.housekeeping.queueRetentionDays"] * 86_400_000).toISOString();
    const blocklistCutoff = new Date(now - cfg["system.housekeeping.blocklistRetentionDays"] * 86_400_000).toISOString();

    const movieIds = (await this.db.select({ id: schema.movie.id }).from(schema.movie)).map((r) => r.id);
    const seriesIds = (await this.db.select({ id: schema.series.id }).from(schema.series)).map((r) => r.id);

    // Condition builder is generic over columns (not tables) — plain `Column` typing,
    // so it doesn't run into Drizzle's per-table generic .delete()/.where() overloads the
    // way a union-typed table parameter would. `ids.length === 0` means "no movies/series
    // exist at all", so every row of that mediaType is an orphan.
    const orphanCondition = (mediaTypeCol: SQLiteColumn, mediaIdCol: SQLiteColumn, mediaType: "movie" | "series", ids: string[]) =>
      ids.length ? and(eq(mediaTypeCol, mediaType), notInArray(mediaIdCol, ids)) : eq(mediaTypeCol, mediaType);

    return this.db.transaction((tx) => {
      // Deliberately written out per table (not genericized over a union table type) —
      // matches the style of deletePolymorphicRows() in media/library.helpers.ts.
      const sweep = (mediaTypeCol: SQLiteColumn, mediaIdCol: SQLiteColumn, del: (cond: ReturnType<typeof orphanCondition>) => number): number =>
        del(orphanCondition(mediaTypeCol, mediaIdCol, "movie", movieIds)) + del(orphanCondition(mediaTypeCol, mediaIdCol, "series", seriesIds));

      const orphansRemoved = {
        mediaFile: sweep(schema.mediaFile.mediaType, schema.mediaFile.mediaId, (cond) => tx.delete(schema.mediaFile).where(cond).run().changes),
        downloadQueueEntry: sweep(schema.downloadQueueEntry.mediaType, schema.downloadQueueEntry.mediaId, (cond) => tx.delete(schema.downloadQueueEntry).where(cond).run().changes),
        historyEntry: sweep(schema.historyEntry.mediaType, schema.historyEntry.mediaId, (cond) => tx.delete(schema.historyEntry).where(cond).run().changes),
        mediaAvailability: sweep(schema.mediaAvailability.mediaType, schema.mediaAvailability.mediaId, (cond) => tx.delete(schema.mediaAvailability).where(cond).run().changes),
        blocklistEntry: sweep(schema.blocklistEntry.mediaType, schema.blocklistEntry.mediaId, (cond) => tx.delete(schema.blocklistEntry).where(cond).run().changes),
      };

      const jobRunsTrimmed = tx.delete(schema.jobRun)
        .where(and(inArray(schema.jobRun.status, TERMINAL_JOB_STATUSES), lt(schema.jobRun.createdAt, jobRunCutoff)))
        .run().changes;

      const auditLogTrimmed = tx.delete(schema.auditLog)
        .where(lt(schema.auditLog.createdAt, auditLogCutoff))
        .run().changes;

      const queueEntriesTrimmed = tx.delete(schema.downloadQueueEntry)
        .where(and(inArray(schema.downloadQueueEntry.status, [...TERMINAL_QUEUE_STATUSES]), lt(schema.downloadQueueEntry.updatedAt, queueCutoff)))
        .run().changes;

      const blocklistTrimmed = tx.delete(schema.blocklistEntry)
        .where(lt(schema.blocklistEntry.createdAt, blocklistCutoff))
        .run().changes;

      return { orphansRemoved, jobRunsTrimmed, auditLogTrimmed, queueEntriesTrimmed, blocklistTrimmed };
    });
  }
}
