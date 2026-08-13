// SPDX-License-Identifier: MIT
import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { count } from "drizzle-orm";
import { schema } from "@medianexus/database";
import type { JobContext } from "@medianexus/jobs";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import { JobsService } from "./jobs.service";
import { AcquisitionService } from "../acquisition/acquisition.service";
import { RssSyncService } from "../acquisition/rss-sync.service";
import { IndexersService } from "../indexers/indexers.service";
import { MediaServersService } from "../media-servers/media-servers.service";
import { MetadataService } from "../metadata/metadata.service";
import { LibraryScanService } from "../library-scan/library-scan.service";

/** Registration of the built-in job handlers (kept small; more land per milestone). */
@Injectable()
export class JobHandlers implements OnModuleInit {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly jobs: JobsService,
    private readonly acquisition: AcquisitionService,
    private readonly rssSync: RssSyncService,
    private readonly indexers: IndexersService,
    private readonly mediaServers: MediaServersService,
    private readonly metadata: MetadataService,
    private readonly libraryScan: LibraryScanService,
  ) {}

  onModuleInit(): void {
    this.jobs.register("system.healthCheck", (ctx) => this.healthCheck(ctx));
    this.jobs.register("discovery.indexerRefresh", () => this.indexerRefresh());
    this.jobs.register("acquisition.downloadMonitor", (ctx) => this.downloadMonitor(ctx));
    this.jobs.register("media.rssSync", () => this.rssSync.runFeedPoll());
    this.jobs.register("media.missingSearch", () => this.rssSync.runMissingSearch());
    this.jobs.register("media.availabilityRefresh", () => this.mediaServers.refreshAll());
    this.jobs.register("media.metadataRefresh", () => this.metadata.refreshMissing(5));
    this.jobs.register("library.scan", () => this.libraryScan.scanAll());
  }

  private async healthCheck(_ctx: JobContext): Promise<unknown> {
    const [m] = await this.db.select({ n: count() }).from(schema.movie);
    const [s] = await this.db.select({ n: count() }).from(schema.series);
    const [h] = await this.db.select({ n: count() }).from(schema.historyEntry);
    return { db: "ok", counts: { movies: m.n, series: s.n, history: h.n } };
  }

  private async indexerRefresh(): Promise<unknown> {
    return this.indexers.refreshAll().catch((e) => ({ error: (e as Error).message }));
  }

  /** Poll all configured download clients and import completed downloads. */
  private async downloadMonitor(_ctx: JobContext): Promise<unknown> {
    return this.acquisition.syncAll();
  }
}
