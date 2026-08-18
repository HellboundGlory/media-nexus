// SPDX-License-Identifier: MIT
import { Inject, Injectable } from "@nestjs/common";
import { and, eq, or } from "drizzle-orm";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import {
  evaluate, type Decision, type DecisionContext,
  type Release, type MediaType, ACTIVE_QUEUE_STATUSES,
} from "@medianexus/domain";
import { LocalStorageProvider } from "@medianexus/integrations";
import { MediaRepository } from "../media/media.repository";
import { BlocklistService } from "../blocklist/blocklist.service";
import { ConfigService } from "../system/config.service";
import { getQualityProfile } from "../media/library.helpers";
import { RootFoldersService } from "../root-folders/root-folders.service";

/**
 * Assembles `DecisionContext` (DB-backed) and calls the pure domain `evaluate()` from
 * `packages/domain/src/decision.ts` — the single place `IndexersService.grab()`,
 * `IndexersService.search()` and `RssSyncService` all go through, so a release is
 * evaluated the same way whether it's grabbed manually, shown in interactive search, or
 * grabbed by RSS sync. See the domain file for the specs themselves; free space was added
 * in roadmap P1 (gap report B8), per-quality size limits and age-retention are still open
 * (roadmap P0.3, gap report B1).
 */
@Injectable()
export class DecisionService {
  private readonly storage = new LocalStorageProvider();

  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly media: MediaRepository,
    private readonly blocklist: BlocklistService,
    private readonly config: ConfigService,
    private readonly rootFolders: RootFoldersService,
  ) {}

  async evaluate(mediaType: MediaType, mediaId: string, release: Release): Promise<Decision> {
    const item = await this.media.find(mediaType, mediaId);
    const target = item ? await this.media.resolveTarget(mediaType, mediaId, release.title) : null;
    if (!item || !target) {
      return {
        release, approved: false, profile: null, formatScore: 0, matchedFormats: [],
        rejections: [{ reason: "unresolved_target", message: "could not determine which media/episode this release is for" }],
      };
    }

    const [existingFiles, isBlocklisted, hasActiveQueueConflict, cfg, profile, freeSpaceBytes, customFormats, releaseProfiles] = await Promise.all([
      this.media.existingFiles(target),
      this.blocklist.isBlocklisted({ mediaType, mediaId, title: release.title, indexerId: release.indexerId }),
      this.hasActiveQueueConflict(mediaType, mediaId),
      this.config.get(),
      getQualityProfile(this.db, item.qualityProfileId),
      this.freeSpaceFor(item.rootFolderPath, mediaType),
      this.db.select().from(schema.customFormat),
      this.db.select().from(schema.releaseProfile).where(eq(schema.releaseProfile.enabled, true)),
    ]);

    const context: DecisionContext = {
      target, profile, existingFiles, isBlocklisted, hasActiveQueueConflict,
      preferredProtocol: cfg["media.preferredProtocol"],
      freeSpaceBytes, minimumFreeSpaceMb: cfg["media.minimumFreeSpaceMb"],
      customFormats,
      formatScores: profile?.formatScores,
      minFormatScore: profile?.minFormatScore,
      cutoffFormatScore: profile?.cutoffFormatScore,
      releaseProfiles,
      mediaTags: item.tags,
    };
    return evaluate(release, context);
  }

  /** Free bytes on the title's assigned root, falling back to the default root folder for
   *  the title's media type — same resolution order as `AcquisitionService.resolveRoot()`.
   *  Null (not zero) when it can't be determined, so the free-space spec doesn't block a
   *  grab on missing data. */
  private async freeSpaceFor(mediaRootPath: string, mediaType: MediaType): Promise<number | null> {
    const root = mediaRootPath || (await this.rootFolders.getDefault(mediaType))?.path;
    if (!root) return null;
    const { free } = await this.storage.diskFree(root);
    return free >= 0 ? free : null;
  }

  async evaluateMany(mediaType: MediaType, mediaId: string, releases: Release[]): Promise<Decision[]> {
    return Promise.all(releases.map((r) => this.evaluate(mediaType, mediaId, r)));
  }

  private async hasActiveQueueConflict(mediaType: MediaType, mediaId: string): Promise<boolean> {
    const rows = await this.db.select({ id: schema.downloadQueueEntry.id }).from(schema.downloadQueueEntry)
      .where(and(
        eq(schema.downloadQueueEntry.mediaType, mediaType),
        eq(schema.downloadQueueEntry.mediaId, mediaId),
        or(...ACTIVE_QUEUE_STATUSES.map((s) => eq(schema.downloadQueueEntry.status, s))),
      )).limit(1);
    return rows.length > 0;
  }
}
