// SPDX-License-Identifier: MIT
import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { count, eq, sql } from "drizzle-orm";
import { schema } from "@medianexus/database";
import { EventTypes } from "@medianexus/events";
import type { JobContext } from "@medianexus/jobs";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import { JobsService } from "./jobs.service";
import { EventsService } from "../events/events.service";
import { MEMORY_DOWNLOAD_CLIENT } from "../providers/demo.providers";
import type { MemoryDownloadClientProvider } from "@medianexus/integrations";

/** Registration of the built-in job handlers (kept small; more land per milestone). */
@Injectable()
export class JobHandlers implements OnModuleInit {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly jobs: JobsService,
    private readonly events: EventsService,
    @Inject(MEMORY_DOWNLOAD_CLIENT) private readonly memClient: MemoryDownloadClientProvider,
  ) {}

  onModuleInit(): void {
    this.jobs.register("system.healthCheck", (ctx) => this.healthCheck(ctx));
    this.jobs.register("discovery.indexerRefresh", () => this.indexerRefresh());
    this.jobs.register("acquisition.downloadMonitor", (ctx) => this.downloadMonitor(ctx));
    this.jobs.register("media.searchForRequest", (ctx) => this.searchForRequest(ctx));
    // event -> job wiring: an approved request kicks a search job (real search in M1)
    this.events.subscribe(EventTypes.RequestApproved, (event) => {
      const payload = (event.payload ?? {}) as { mediaId?: string; mediaType?: string };
      void this.jobs.dispatch({
        jobKey: "media.searchForRequest",
        trigger: "event",
        payload: { mediaId: payload.mediaId, mediaType: payload.mediaType, requestId: event.aggregate.requestId },
      });
    });
  }

  private async healthCheck(_ctx: JobContext): Promise<unknown> {
    const [m] = await this.db.select({ n: count() }).from(schema.movie);
    const [s] = await this.db.select({ n: count() }).from(schema.series);
    const [r] = await this.db.select({ n: count() }).from(schema.request);
    const [h] = await this.db.select({ n: count() }).from(schema.historyEntry);
    return { db: "ok", counts: { movies: m.n, series: s.n, requests: r.n, history: h.n } };
  }

  private async indexerRefresh(): Promise<unknown> {
    const rows = await this.db.select().from(schema.indexer).where(eq(schema.indexer.enabled, true));
    // M1: real healthchecks per configured indexer via providers. Today: mark disabled/untested.
    return { checked: rows.length, perProvider: "M1" };
  }

  /** Demo pipeline: pull the in-memory client queue; import anything completed. */
  private async downloadMonitor(_ctx: JobContext): Promise<unknown> {
    const queue = await this.memClient.getQueue();
    const completed = queue.filter((q) => q.status === "completed");
    if (completed.length === 0) return { scanned: queue.length, imports: 0 };

    let imported = 0;
    for (const item of completed) {
      const entry = await this.db
        .select()
        .from(schema.downloadQueueEntry)
        .where(sql`${schema.downloadQueueEntry.downloadId} = ${item.downloadId}`)
        .limit(1);
      const row = entry[0];
      if (!row) continue;
      // mark queue imported
      await this.db.update(schema.downloadQueueEntry)
        .set({ status: "imported", progress: 100, updatedAt: new Date().toISOString() })
        .where(eq(schema.downloadQueueEntry.id, row.id));

      // link media_file + availability + history (movies; series episode linking is M2)
      const now = new Date().toISOString();
      await this.db.insert(schema.mediaFile).values({
        id: `mf_${row.id.replace(/[^a-z0-9]/gi, "").slice(0, 16)}`,
        mediaType: row.mediaType as any,
        mediaId: row.mediaId,
        episodeIds: [],
        relativePath: `/media/${row.mediaType}/${row.mediaId}/${sanitize(row.title)}.mkv`,
        size: row.size,
        quality: { source: "web", resolution: "1080p", edition: "" },
        dateAdded: now,
      });
      await this.db.insert(schema.historyEntry).values({
        id: `hist_import_${Date.now()}_${imported}`,
        mediaType: row.mediaType as any,
        mediaId: row.mediaId,
        action: "import_completed",
        data: { title: row.title, downloadId: item.downloadId },
        createdAt: now,
      });
      if (row.mediaType === "movie") {
        await this.db.update(schema.movie).set({ hasFile: true, updatedAt: now }).where(eq(schema.movie.id, row.mediaId));
        await this.db.update(schema.mediaAvailability)
          .set({ status: "available", lastAvailabilitySyncAt: now })
          .where(eq(schema.mediaAvailability.mediaId, row.mediaId));
      }
      await this.memClient.remove(item.downloadId);
      this.events.publish(EventTypes.ImportCompleted, { mediaType: row.mediaType, mediaId: row.mediaId, downloadId: item.downloadId }, { aggType: row.mediaType as any, aggId: row.mediaId });
      imported++;
    }
    return { scanned: queue.length, imports: imported };
  }

  /** Stub for M1: proves the approved-request -> search-job pipeline end-to-end. */
  private async searchForRequest(ctx: JobContext): Promise<unknown> {
    return { status: "stubbed", note: "real search wired in M1", payload: ctx.payload };
  }
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9 _()[\]-]/g, "").replace(/\s+/g, " ").trim();
}
