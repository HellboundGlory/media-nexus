// SPDX-License-Identifier: MIT
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Db } from "@medianexus/database";
import { schema } from "@medianexus/database";
import { newEntityId } from "@medianexus/shared";
import type { MediaType, QualityProfileLike } from "@medianexus/domain";

/**
 * Small shared pieces of the movie/series services. These two paths had independently
 * written — and independently drifting — copies of pagination, title search and the
 * availability upsert; there is nothing media-type-specific about any of them.
 */

export interface LibraryListQuery {
  search?: string;
  monitored?: string;
  page?: number;
  pageSize?: number;
}

export interface PagedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export const MAX_PAGE_SIZE = 100;

export function normalizePaging(q: LibraryListQuery): { page: number; pageSize: number; offset: number } {
  const page = Math.max(1, q.page ?? 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, q.pageSize ?? 50));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/** Case-insensitive contains-match on a title column. */
export function titleSearchCondition(column: unknown, search: string | undefined): SQL | undefined {
  const term = search?.trim();
  if (!term) return undefined;
  return sql`lower(${column}) like ${`%${term.toLowerCase()}%`}`;
}

export function combine(conds: (SQL | undefined)[]): SQL | undefined {
  const present = conds.filter((c): c is SQL => c !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return and(...present);
}

/**
 * One paginated list query for any library table with a title and an addedAt column.
 * Runs the page and the count in parallel — they are independent.
 */
export async function listPaged<T>(
  db: Db,
  table: SQLiteTable & { addedAt: SQLiteColumn },
  where: SQL | undefined,
  q: LibraryListQuery,
): Promise<PagedResult<T>> {
  const { page, pageSize, offset } = normalizePaging(q);
  const [rows, totals] = await Promise.all([
    db.select().from(table).where(where).orderBy(desc(table.addedAt)).limit(pageSize).offset(offset),
    db.select({ n: sql<number>`count(*)` }).from(table).where(where),
  ]);
  return { items: rows as T[], total: Number(totals[0]?.n ?? 0), page, pageSize };
}

/**
 * Ensure a media_availability row exists for a title. Previously the movie path used an
 * upsert and the series path a fire-and-forget insert whose failure was swallowed, which
 * left series with no availability row and made later availability updates silent no-ops.
 */
export async function ensureAvailability(db: Db, mediaType: MediaType, mediaId: string): Promise<void> {
  const existing = await db.select({ id: schema.mediaAvailability.id })
    .from(schema.mediaAvailability)
    .where(and(
      sql`${schema.mediaAvailability.mediaType} = ${mediaType}`,
      sql`${schema.mediaAvailability.mediaId} = ${mediaId}`,
    ))
    .limit(1);
  if (existing.length) return;
  await db.insert(schema.mediaAvailability).values({
    id: newEntityId("av"),
    mediaType,
    mediaId,
    status: "unknown",
  });
}

/** The synchronous transaction handle better-sqlite3 hands to a `db.transaction()`
 *  callback — same query-builder surface as `Db`, but every write must be `.run()`, not
 *  `await`ed (better-sqlite3 transaction callbacks cannot be async). */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Delete every polymorphic `(mediaType, mediaId)` row referencing a title being removed —
 * media_file, download_queue_entry, history_entry, media_availability, blocklist_entry.
 * These tables can't carry a real SQL foreign key (they point at either `movie` or
 * `series` depending on the discriminator column, see "Two media tables, polymorphic
 * references" in the architecture notes), so this is the cascade's application-level half;
 * the DB-level FK handles `season`/`episode` automatically once the `series` row itself is
 * deleted (roadmap P0.7). Caller must run this inside the same transaction as the
 * movie/series row's own delete and use the sync `.run()` form throughout — this function
 * takes a `Tx`, not a `Db`, so that can't be forgotten.
 */
export function deletePolymorphicRows(tx: Tx, mediaType: MediaType, mediaId: string): void {
  tx.delete(schema.mediaFile).where(and(eq(schema.mediaFile.mediaType, mediaType), eq(schema.mediaFile.mediaId, mediaId))).run();
  tx.delete(schema.downloadQueueEntry).where(and(eq(schema.downloadQueueEntry.mediaType, mediaType), eq(schema.downloadQueueEntry.mediaId, mediaId))).run();
  tx.delete(schema.historyEntry).where(and(eq(schema.historyEntry.mediaType, mediaType), eq(schema.historyEntry.mediaId, mediaId))).run();
  tx.delete(schema.mediaAvailability).where(and(eq(schema.mediaAvailability.mediaType, mediaType), eq(schema.mediaAvailability.mediaId, mediaId))).run();
  tx.delete(schema.blocklistEntry).where(and(eq(schema.blocklistEntry.mediaType, mediaType), eq(schema.blocklistEntry.mediaId, mediaId))).run();
}

/** Sync counterpart of `ensureAvailability`, for use inside a `db.transaction()` callback
 *  (better-sqlite3 transaction callbacks cannot `await`). Same upsert semantics. */
export function ensureAvailabilitySync(tx: Tx, mediaType: MediaType, mediaId: string): void {
  const existing = tx.select({ id: schema.mediaAvailability.id })
    .from(schema.mediaAvailability)
    .where(and(
      sql`${schema.mediaAvailability.mediaType} = ${mediaType}`,
      sql`${schema.mediaAvailability.mediaId} = ${mediaId}`,
    ))
    .all();
  if (existing.length) return;
  tx.insert(schema.mediaAvailability).values({
    id: newEntityId("av"),
    mediaType,
    mediaId,
    status: "unknown",
  }).run();
}

/** Look up a quality profile in the shape the domain layer (`qualityAllowed`/
 *  `meetsCutoff`/decision engine) consumes. Shared by `DecisionService` (P0.3) and the
 *  import engine (P0.5) — one implementation of "resolve a title's assigned profile". */
export async function getQualityProfile(db: Db, qualityProfileId: string | null): Promise<QualityProfileLike | null> {
  if (!qualityProfileId) return null;
  const rows = await db
    .select({
      items: schema.qualityProfile.items,
      cutoffQualityId: schema.qualityProfile.cutoffQualityId,
      formatScores: schema.qualityProfile.formatScores,
      minFormatScore: schema.qualityProfile.minFormatScore,
      cutoffFormatScore: schema.qualityProfile.cutoffFormatScore,
    })
    .from(schema.qualityProfile).where(eq(schema.qualityProfile.id, qualityProfileId)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    items: row.items,
    cutoffQualityId: row.cutoffQualityId,
    formatScores: row.formatScores ?? {},
    minFormatScore: row.minFormatScore ?? 0,
    cutoffFormatScore: row.cutoffFormatScore ?? 0,
  };
}
