// SPDX-License-Identifier: MIT
import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { count } from "drizzle-orm";
import { schema } from "@medianexus/database";
import { EventTypes } from "@medianexus/events";
import type { JobContext } from "@medianexus/jobs";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import { JobsService } from "./jobs.service";
import { EventsService } from "../events/events.service";
import { AcquisitionService } from "../acquisition/acquisition.service";
import { RssSyncService } from "../acquisition/rss-sync.service";
import { IndexersService } from "../indexers/indexers.service";
import { RequestFulfillmentService } from "../requests/request-fulfillment.service";
import { MediaServersService } from "../requests/media-servers.service";

/** Registration of the built-in job handlers (kept small; more land per milestone). */
@Injectable()
export class JobHandlers implements OnModuleInit {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly jobs: JobsService,
    private readonly events: EventsService,
    private readonly acquisition: AcquisitionService,
    private readonly rssSync: RssSyncService,
    private readonly indexers: IndexersService,
    private readonly fulfillment: RequestFulfillmentService,
    private readonly mediaServers: MediaServersService,
  ) {}

  onModuleInit(): void {
    this.jobs.register("system.healthCheck", (ctx) => this.healthCheck(ctx));
    this.jobs.register("discovery.indexerRefresh", () => this.indexerRefresh());
    this.jobs.register("acquisition.downloadMonitor", (ctx) => this.downloadMonitor(ctx));
    this.jobs.register("media.searchForRequest", (ctx) => this.searchForRequest(ctx));
    this.jobs.register("media.rssSync", () => this.rssSync.run());
    this.jobs.register("media.availabilityRefresh", () => this.mediaServers.refreshAll());
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
    return this.indexers.refreshAll().catch((e) => ({ error: (e as Error).message }));
  }

  /** Poll all configured download clients and import completed downloads (M1). */
  private async downloadMonitor(_ctx: JobContext): Promise<unknown> {
    return this.acquisition.syncAll();
  }

  /** M4: an approved request searches indexers and auto-grabs the best release. */
  private async searchForRequest(ctx: JobContext): Promise<unknown> {
    const requestId = (ctx.payload.requestId ?? ctx.requestId) as string | undefined;
    if (!requestId) return { status: "no-request-id" };
    const r = await this.fulfillment.fulfillRequest(requestId);
    return { requestId, ...r };
  }
}
