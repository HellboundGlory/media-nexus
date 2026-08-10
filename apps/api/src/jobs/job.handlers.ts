// SPDX-License-Identifier: MIT
import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { count, eq } from "drizzle-orm";
import { schema } from "@medianexus/database";
import { EventTypes } from "@medianexus/events";
import type { JobContext } from "@medianexus/jobs";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import { JobsService } from "./jobs.service";
import { EventsService } from "../events/events.service";
import { AcquisitionService } from "../acquisition/acquisition.service";

/** Registration of the built-in job handlers (kept small; more land per milestone). */
@Injectable()
export class JobHandlers implements OnModuleInit {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly jobs: JobsService,
    private readonly events: EventsService,
    private readonly acquisition: AcquisitionService,
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

  /** Poll all configured download clients and import completed downloads (M1). */
  private async downloadMonitor(_ctx: JobContext): Promise<unknown> {
    return this.acquisition.syncAll();
  }

  /** Stub for M1: proves the approved-request -> search-job pipeline end-to-end. */
  private async searchForRequest(ctx: JobContext): Promise<unknown> {
    return { status: "stubbed", note: "real search wired in M1", payload: ctx.payload };
  }
}
