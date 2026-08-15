// SPDX-License-Identifier: MIT
import { Injectable, OnModuleInit } from "@nestjs/common";
import type { JobContext } from "@medianexus/jobs";
import { JobsService } from "./jobs.service";
import { AcquisitionService } from "../acquisition/acquisition.service";
import { RssSyncService } from "../acquisition/rss-sync.service";
import { IndexersService } from "../indexers/indexers.service";
import { MediaServersService } from "../media-servers/media-servers.service";
import { MetadataService } from "../metadata/metadata.service";
import { LibraryScanService } from "../library-scan/library-scan.service";
import { RecycleBinService } from "../media/recycle-bin.service";
import { MediaProbeService } from "../media/media-probe.service";
import { HealthCheckService } from "../health/health-check.service";
import { HousekeepingService } from "../system/housekeeping.service";
import { BackupService } from "../system/backup.service";
import { UpdateCheckService } from "../system/update-check.service";
import { ImportListsService } from "../import-lists/import-lists.service";
import { CardigannSyncService } from "../indexers/cardigann-sync.service";

/** Registration of the built-in job handlers (kept small; more land per milestone). */
@Injectable()
export class JobHandlers implements OnModuleInit {
  constructor(
    private readonly jobs: JobsService,
    private readonly acquisition: AcquisitionService,
    private readonly rssSync: RssSyncService,
    private readonly indexers: IndexersService,
    private readonly mediaServers: MediaServersService,
    private readonly metadata: MetadataService,
    private readonly importLists: ImportListsService,
    private readonly cardigannSync: CardigannSyncService,
    private readonly libraryScan: LibraryScanService,
    private readonly recycleBin: RecycleBinService,
    private readonly mediaProbe: MediaProbeService,
    private readonly healthCheck: HealthCheckService,
    private readonly housekeeping: HousekeepingService,
    private readonly backup: BackupService,
    private readonly updateCheck: UpdateCheckService,
  ) {}

  onModuleInit(): void {
    this.jobs.register("system.healthCheck", () => this.healthCheck.run());
    this.jobs.register("system.housekeeping", () => this.housekeeping.run());
    this.jobs.register("system.backup", () => this.backup.run());
    this.jobs.register("system.updateCheck", () => this.updateCheck.run());
    this.jobs.register("discovery.indexerRefresh", () => this.indexerRefresh());
    this.jobs.register("acquisition.downloadMonitor", (ctx) => this.downloadMonitor(ctx));
    this.jobs.register("media.rssSync", () => this.rssSync.runFeedPoll());
    this.jobs.register("media.missingSearch", () => this.rssSync.runMissingSearch());
    this.jobs.register("media.availabilityRefresh", () => this.mediaServers.refreshAll());
    this.jobs.register("media.metadataRefresh", () => this.metadata.refreshMissing(5));
    this.jobs.register("media.importLists", () => this.importLists.runAll());
    this.jobs.register("media.definitionSync", () => this.cardigannSync.run());
    this.jobs.register("library.scan", () => this.libraryScan.scanAll());
    this.jobs.register("media.recycleBinTrim", () => this.recycleBin.purgeExpired());
    this.jobs.register("media.mediaInfoRefresh", () => this.mediaProbe.probeMissing(20));
  }

  private async indexerRefresh(): Promise<unknown> {
    return this.indexers.refreshAll().catch((e) => ({ error: (e as Error).message }));
  }

  /** Poll all configured download clients and import completed downloads. */
  private async downloadMonitor(_ctx: JobContext): Promise<unknown> {
    return this.acquisition.syncAll();
  }
}
