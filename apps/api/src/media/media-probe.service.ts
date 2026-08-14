// SPDX-License-Identifier: MIT
import { Inject, Injectable, Logger } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import { MediaRepository } from "./media.repository";
import { probeMediaFile } from "@medianexus/integrations";
import { toMediaInfo, type MediaType, type RawFfprobeOutput } from "@medianexus/domain";

export type ProbeFn = (absolutePath: string) => Promise<RawFfprobeOutput | null>;

/**
 * Media info probing (roadmap P2 item 6): fills `media_file.mediaInfo` + `media_file.languages`
 * for rows that still carry the JSON `'[]'` placeholder. Deliberately a poll-and-reconcile loop,
 * not an event-driven dispatch from the five insert call sites: it needs zero changes to
 * acquisition or library-scan, survives a restart mid-probe (no in-flight event to lose), and the
 * `media_info = '[]'` candidate filter means a successfully-probed row permanently drops out of
 * the set on the next run (the exact guard that keeps this clear of the D5 bug pattern in
 * `metadata.refreshMissing`, which picks up the same rows forever for lack of a filter).
 *
 * NOTE on the sentinel: the migration declares `media_info`/`languages` as `NOT NULL DEFAULT '[]'`
 * (the drizzle schema types them nullable, which is a pre-existing mismatch), so rows can never
 * hold SQL null. '[]' is therefore the "not yet probed" marker. Files ffprobe can't parse
 * (corrupt, unsupported, or the binary itself missing) are left as '[]' — they stay in the
 * candidate set and are retried next cycle (bounded by batch), never an error out of this job.
 */
@Injectable()
export class MediaProbeService {
  private readonly logger = new Logger(MediaProbeService.name);

  /** Swappable in tests; defaults to the real ffprobe wrapper. */
  probe: ProbeFn = probeMediaFile;

  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly media: MediaRepository,
  ) {}

  async probeMissing(limit = 20): Promise<{ probed: number; skipped: number; unavailable: number }> {
    // Candidate set = rows still holding the '[]' placeholder (the NOT-NULL DB default that
    // every unprobed row carries). A successful probe writes a JSON object, so the row drops
    // out on the next run.
    const rows = await this.db
      .select()
      .from(schema.mediaFile)
      .where(sql`${schema.mediaFile.mediaInfo} = '[]'`)
      .limit(limit);

    if (rows.length === 0) return { probed: 0, skipped: 0, unavailable: 0 };

    let probed = 0;
    let skipped = 0;
    let unavailable = 0;
    let firstBadPath: string | null = null;

    for (const row of rows) {
      const item = await this.media.find(row.mediaType as MediaType, row.mediaId);
      // Orphaned row or a title without a configured root folder — nothing to resolve the
      // file against. Not this job's cleanup.
      if (!item?.rootFolderPath) {
        skipped++;
        continue;
      }
      const absPath = join(item.rootFolderPath, row.relativePath);
      // Stale row whose file vanished — library-scan's next pass removes these; don't
      // manufacture a probe call for a path that isn't there.
      if (!existsSync(absPath)) {
        skipped++;
        continue;
      }

      const raw = await this.probe(absPath);
      if (!raw) {
        // Leave the row as '[]' — it stays in the candidate set and retries next cycle.
        unavailable++;
        if (!firstBadPath) firstBadPath = absPath;
        continue;
      }
      await this.db.update(schema.mediaFile).set(toMediaInfo(raw))
        .where(eq(schema.mediaFile.id, row.id));
      probed++;
    }

    if (unavailable > 0) {
      // One aggregate warning, not one per file — a missing/broken ffprobe touches every
      // row in the batch and must not spam the log.
      this.logger.warn(
        `media probe: ${unavailable}/${rows.length} file(s) could not be probed ` +
        `(ffprobe unavailable or unparseable); left unprobed for retry${firstBadPath ? ` — e.g. ${firstBadPath}` : ""}`,
      );
    }

    return { probed, skipped, unavailable };
  }
}
