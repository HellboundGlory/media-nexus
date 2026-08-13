// SPDX-License-Identifier: MIT
import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { newEntityId, ApiError } from "@medianexus/shared";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import { normalizePaging, type LibraryListQuery, type PagedResult } from "../media/library.helpers";

export interface BlocklistCandidate {
  mediaType: "movie" | "series";
  mediaId: string;
  title: string;
  indexerId?: string | null;
  torrentInfohash?: string | null;
}

/**
 * Blocklist (roadmap P0.4, gap report B6): `blocklist_entry` existed since `0000_init`
 * with zero references anywhere. Without it, a release that fails every time it's grabbed
 * (bad NZB, dead torrent, wrong content) gets grabbed again on the next RSS pass — the only
 * defense today is a 6-hour dedupe window in RssSyncService, which is a rate limiter, not
 * "don't try this release again."
 *
 * Match key is (mediaType, mediaId, title), narrowed by indexerId when both sides have one.
 * Title is the strongest signal available at grab/import time — the same release grabbed
 * twice has the same title by construction. `torrentInfohash` is captured for a stronger
 * future match but nothing populates it yet (Release carries no hash field today).
 */
@Injectable()
export class BlocklistService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  /** Deliberately called only for release-level failures (this specific download was bad),
   *  never for client/indexer-outage failures — those mean try again later, not "never
   *  again." See callers in AcquisitionService.recordImportFailure(). */
  async add(input: BlocklistCandidate & { reason: string }): Promise<void> {
    await this.db.insert(schema.blocklistEntry).values({
      id: newEntityId("bl"),
      mediaType: input.mediaType,
      mediaId: input.mediaId,
      indexerId: input.indexerId ?? null,
      title: input.title,
      torrentInfohash: input.torrentInfohash ?? null,
      reason: input.reason,
      createdAt: new Date().toISOString(),
    });
  }

  /** Consulted by both IndexersService.grab() and RssSyncService before a release is
   *  chosen/grabbed — one shared implementation, not two copies. */
  async isBlocklisted(candidate: { mediaType: string; mediaId: string; title: string; indexerId?: string | null }): Promise<boolean> {
    const conds = [
      eq(schema.blocklistEntry.mediaType, candidate.mediaType),
      eq(schema.blocklistEntry.mediaId, candidate.mediaId),
      eq(schema.blocklistEntry.title, candidate.title),
    ];
    if (candidate.indexerId) conds.push(eq(schema.blocklistEntry.indexerId, candidate.indexerId));
    const rows = await this.db.select({ id: schema.blocklistEntry.id }).from(schema.blocklistEntry).where(and(...conds)).limit(1);
    return rows.length > 0;
  }

  async list(q: LibraryListQuery & { mediaType?: string; mediaId?: string }): Promise<PagedResult<typeof schema.blocklistEntry.$inferSelect>> {
    const { page, pageSize, offset } = normalizePaging(q);
    const conds = [];
    if (q.mediaType) conds.push(eq(schema.blocklistEntry.mediaType, q.mediaType));
    if (q.mediaId) conds.push(eq(schema.blocklistEntry.mediaId, q.mediaId));
    const where = conds.length ? and(...conds) : undefined;
    const [rows, totals] = await Promise.all([
      this.db.select().from(schema.blocklistEntry).where(where).orderBy(desc(schema.blocklistEntry.createdAt)).limit(pageSize).offset(offset),
      this.db.select({ n: sql<number>`count(*)` }).from(schema.blocklistEntry).where(where),
    ]);
    return { items: rows, total: Number(totals[0]?.n ?? 0), page, pageSize };
  }

  async remove(id: string) {
    const existing = await this.db.select({ id: schema.blocklistEntry.id }).from(schema.blocklistEntry).where(eq(schema.blocklistEntry.id, id)).limit(1);
    if (!existing[0]) throw ApiError.notFound("blocklist entry", id);
    await this.db.delete(schema.blocklistEntry).where(eq(schema.blocklistEntry.id, id));
    return { removed: id };
  }
}
