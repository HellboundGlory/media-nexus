// SPDX-License-Identifier: MIT
import { and, desc, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Db } from "@medianexus/database";
import { schema } from "@medianexus/database";
import { newEntityId } from "@medianexus/shared";
import type { MediaType } from "@medianexus/domain";

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
