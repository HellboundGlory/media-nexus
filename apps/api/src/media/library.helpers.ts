// SPDX-License-Identifier: MIT
import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Db } from "@medianexus/database";
import { schema } from "@medianexus/database";
import { ApiError, newEntityId } from "@medianexus/shared";
import { pickBest, type MediaType, type QualityProfileLike, type Release } from "@medianexus/domain";
import { matchingFormats, existingFileMatchInput, type CustomFormat } from "@medianexus/domain";
import { join } from "node:path";
import { LocalStorageProvider } from "@medianexus/integrations";
import { selectMediaFiles, type MediaFileRow } from "./media-file.types";
import type { EventsService } from "../events/events.service";
import type { IndexersService } from "../indexers/indexers.service";
import type { RecycleBinService } from "./recycle-bin.service";

/**
 * Small shared pieces of the movie/series services. These two paths had independently
 * written — and independently drifting — copies of pagination, title search and the
 * availability upsert; there is nothing media-type-specific about any of them.
 */

export interface LibraryListQuery {
  search?: string;
  monitored?: string;
  /** UNI-029: a recognized sort-column key (title/year/added/monitored) resolved via the
   *  caller's sortColumns map; absent/unknown falls back to the default addedAt-descending order. */
  sort?: string;
  sortDir?: "asc" | "desc";
  /** UNI-029: movies-only list filter, e.g. "missing" -> monitored && fileless. */
  filter?: string;
  page?: number;
  pageSize?: number;
}

export interface PagedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

const MAX_PAGE_SIZE = 100;

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
 * `opts.sortColumns` maps a requested `q.sort` key to the actual column (the caller supplies it
 * because movie and series differ — movie "year" is `releaseDate`, series "year" is
 * `firstAirYear`). An absent/unknown `q.sort` keeps the historical `desc(addedAt)` default.
 */
export async function listPaged<T>(
  db: Db,
  table: SQLiteTable & { addedAt: SQLiteColumn },
  where: SQL | undefined,
  q: LibraryListQuery,
  opts?: { sortColumns?: Record<string, SQLiteColumn> },
): Promise<PagedResult<T>> {
  const { page, pageSize, offset } = normalizePaging(q);
  const sortCol = q.sort ? opts?.sortColumns?.[q.sort] : undefined;
  const order = sortCol ? [q.sortDir === "asc" ? asc(sortCol) : desc(sortCol)] : [desc(table.addedAt)];
  const [rows, totals] = await Promise.all([
    db.select().from(table).where(where).orderBy(...order).limit(pageSize).offset(offset),
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

/** Async counterpart of `ensureAvailabilitySync`, for use inside a Postgres
 *  `db.transaction(async (tx) => ...)` callback (roadmap P2 item 12 Stage 2 — the two
 *  transaction drivers have irreconcilable callback signatures, so Postgres transactions
 *  need `await`-based bodies). Same upsert semantics. */
export async function ensureAvailabilityTx(tx: Tx, mediaType: MediaType, mediaId: string): Promise<void> {
  const existing = await tx.select({ id: schema.mediaAvailability.id })
    .from(schema.mediaAvailability)
    .where(and(
      sql`${schema.mediaAvailability.mediaType} = ${mediaType}`,
      sql`${schema.mediaAvailability.mediaId} = ${mediaId}`,
    ))
    .limit(1);
  if (existing.length) return;
  await tx.insert(schema.mediaAvailability).values({
    id: newEntityId("av"),
    mediaType,
    mediaId,
    status: "unknown",
  });
}

/** Async counterpart of `deletePolymorphicRows`, for use inside a Postgres transaction
 *  callback. Same application-level cascade semantics; `await`-based (see ADR-004 Stage 2). */
export async function deletePolymorphicRowsAsync(tx: Tx, mediaType: MediaType, mediaId: string): Promise<void> {
  await tx.delete(schema.mediaFile).where(and(eq(schema.mediaFile.mediaType, mediaType), eq(schema.mediaFile.mediaId, mediaId)));
  await tx.delete(schema.downloadQueueEntry).where(and(eq(schema.downloadQueueEntry.mediaType, mediaType), eq(schema.downloadQueueEntry.mediaId, mediaId)));
  await tx.delete(schema.historyEntry).where(and(eq(schema.historyEntry.mediaType, mediaType), eq(schema.historyEntry.mediaId, mediaId)));
  await tx.delete(schema.mediaAvailability).where(and(eq(schema.mediaAvailability.mediaType, mediaType), eq(schema.mediaAvailability.mediaId, mediaId)));
  await tx.delete(schema.blocklistEntry).where(and(eq(schema.blocklistEntry.mediaType, mediaType), eq(schema.blocklistEntry.mediaId, mediaId)));
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

/** Populate each file's `matchedFormats` — the subset of CURRENT custom format definitions
 *  the file matches, computed live at read time (matching upstream: editing a custom format
 *  retroactively changes what existing files show, they are not frozen at import the way
 *  queue/history grab events are). Called only by the movie/series /files endpoints — the
 *  rename and acquisition paths share `MediaFileRow` but don't need this and don't pay for
 *  the extra query. `matchingFormats` derives the per-file reduced view from the filename,
 *  so a file with no probe (null `quality`) matches nothing. */
export async function attachMatchedFormats(
  db: Db,
  files: MediaFileRow[],
): Promise<MediaFileRow[]> {
  if (files.length === 0) return files;
  const customFormats = (await db.select().from(schema.customFormat)) as CustomFormat[];
  if (customFormats.length === 0) return files; // nothing configured — leave matchedFormats []
  for (const f of files) {
    if (!f.quality) continue; // no quality -> no possible match, stays []
    f.matchedFormats = matchingFormats(
      customFormats,
      existingFileMatchInput({ relativePath: f.relativePath, size: f.size, quality: f.quality as never }),
    ).map((fmt) => ({ id: fmt.id, name: fmt.name }));
  }
  return files;
}

// ---------------------------------------------------------------------------
// Shared movie/series CRUD plumbing (roadmap J1). The two services' get()/files()/credits()/
// remove()/auto-search paths carried independently written — and independently drifting —
// copies of the same control flow; only the table, on-disk folder name, removed/download-
// failed event and the match/query predicate genuinely differ. Everything below is
// parameterized over those, so the movie and series paths cannot drift the way they did.
// ---------------------------------------------------------------------------

/** Throw the standard notFound error when a fetched row is absent. The movie/series get()
 *  lookups differ only in table and label; this holds the shared 404 mechanics. */
export function requireFound<T>(row: T | null | undefined, mediaType: "movie" | "series", id: string): T {
  if (row == null) throw ApiError.notFound(mediaType, id);
  return row;
}

/** Existence-check a title (404 on missing) before a read that needs it. */
async function requireTitleExists(db: Db, mediaType: "movie" | "series", mediaId: string): Promise<void> {
  const q: PromiseLike<{ id: string }[]> = mediaType === "movie"
    ? db.select({ id: schema.movie.id }).from(schema.movie).where(eq(schema.movie.id, mediaId)).limit(1)
    : db.select({ id: schema.series.id }).from(schema.series).where(eq(schema.series.id, mediaId)).limit(1);
  const rows = await q;
  requireFound(rows[0], mediaType, mediaId);
}

/** A title's media_file rows after a 404 existence check — the shared body of both /files
 *  endpoints (selectMediaFiles is the shared row query; this adds the existence gate both
 *  services previously got from calling their get() first). */
export async function getMediaFiles(db: Db, mediaType: "movie" | "series", mediaId: string): Promise<MediaFileRow[]> {
  await requireTitleExists(db, mediaType, mediaId);
  return selectMediaFiles(db, mediaType, mediaId);
}

/** A title's cast/crew split (cast ordered top-billed first) — the shared body of both
 *  credits endpoints. */
export async function getMediaCredits(db: Db, mediaType: "movie" | "series", mediaId: string) {
  await requireTitleExists(db, mediaType, mediaId);
  const rows = await db.select().from(schema.mediaCredit)
    .where(and(eq(schema.mediaCredit.mediaType, mediaType), eq(schema.mediaCredit.mediaId, mediaId)))
    .orderBy(asc(schema.mediaCredit.sortOrder));
  return {
    cast: rows.filter((r) => r.role === "cast"),
    crew: rows.filter((r) => r.role === "crew"),
  };
}

/** Move every file of a title into the recycle bin, then delete the title's folder itself
 *  (recursive — also removes untracked extras/subtitles, matching upstream). A file already
 *  missing on disk is wrapped + logged so it can't block the rest of the delete; a
 *  folder-delete failure surfaces normally. */
async function disposeTitleFiles(
  db: Db, recycleBin: RecycleBinService, mediaType: "movie" | "series", id: string,
  root: string, folderName: string, logWarn: (msg: string) => void,
): Promise<void> {
  const files = await db.select().from(schema.mediaFile)
    .where(and(eq(schema.mediaFile.mediaType, mediaType), eq(schema.mediaFile.mediaId, id)));
  const storage = new LocalStorageProvider();
  for (const f of files) {
    // relativePath is root-relative and includes the title-folder prefix — no double join.
    const abs = join(root, f.relativePath);
    try {
      await recycleBin.dispose(abs);
    } catch (err) {
      logWarn(`Failed to dispose ${mediaType} file ${abs}: ${(err as Error).message}`);
    }
  }
  await storage.delete(join(root, folderName));
}

/** Remove a library title end-to-end. Movies and series differ only in: the row/table to
 *  delete, the optional on-disk folder name, the import-exclusion mediaType key, and the
 *  removed event. Everything else — optional file dispose + recursive folder delete, the
 *  transactional polymorphic cascade (Postgres-vs-SQLite split), the import-exclusion
 *  insert — is shared. Each service supplies the media-type-specific pieces and a `publish`
 *  callback that emits its own removed event. */
export async function removeMediaItem(
  db: Db,
  deps: { events: EventsService; recycleBin: RecycleBinService; logWarn: (msg: string) => void },
  opts: {
    mediaType: "movie" | "series";
    id: string;
    rootFolderPath: string | null;
    folderName: string;
    tmdbId: number | null;
    title: string;
    year: number | null;
    deleteFiles: boolean;
    addImportExclusion: boolean;
    publish: (events: EventsService, id: string) => void;
  },
): Promise<{ removed: string }> {
  const { mediaType, id, rootFolderPath, folderName, tmdbId, title, year, deleteFiles, addImportExclusion, publish } = opts;
  // Before the DB cascade: physically delete each file and the title's folder when requested
  // (opt-in — a bare DELETE on its own does nothing to disk, matching upstream).
  if (deleteFiles) {
    await disposeTitleFiles(db, deps.recycleBin, mediaType, id, rootFolderPath ?? "", folderName, deps.logWarn);
  }
  // Only the polymorphic tables need a hand-written delete here — a series' season/episode
  // cascade automatically via their DB-level FK to series once the series row is deleted.
  if (db.dbDialect === "postgres") {
    // better-sqlite3's native tx wrapper needs a sync callback; node-postgres needs async
    // (P2 item 12 Stage 2) — two irreconcilable signatures, so Postgres gets its own body.
    await db.transaction(async (tx) => {
      await deletePolymorphicRowsAsync(tx, mediaType, id);
      if (mediaType === "movie") await tx.delete(schema.movie).where(eq(schema.movie.id, id));
      else await tx.delete(schema.series).where(eq(schema.series.id, id));
      // C2 import lists: only exclude from re-import when explicitly requested (opt-in).
      // The title is already in scope in the caller — captured here so the exclusions list can
      // display a real title instead of a raw id (IMPORTEXCLTITLE-1), with zero external calls.
      if (addImportExclusion && tmdbId != null) {
        await tx.insert(schema.importExclusion).values({
          id: `excl-${mediaType}-${tmdbId}`, mediaType, externalId: String(tmdbId),
          reason: "removed from library", title, year, createdAt: new Date().toISOString(),
        }).onConflictDoNothing();
      }
    });
  } else {
    db.transaction((tx) => {
      deletePolymorphicRows(tx, mediaType, id);
      if (mediaType === "movie") tx.delete(schema.movie).where(eq(schema.movie.id, id)).run();
      else tx.delete(schema.series).where(eq(schema.series.id, id)).run();
      if (addImportExclusion && tmdbId != null) {
        tx.insert(schema.importExclusion).values({
          id: `excl-${mediaType}-${tmdbId}`, mediaType, externalId: String(tmdbId),
          reason: "removed from library", title, year, createdAt: new Date().toISOString(),
        }).onConflictDoNothing().run();
      }
    });
  }
  publish(deps.events, id);
  return { removed: id };
}

/** The shared composition behind both services' on-demand "Search + auto-grab": fetch
 *  releases, filter to the ones matching the target, pick the best *approved* candidate via
 *  the decision engine, grab it, and map the failure path. `grabbed: false` means no
 *  acceptable release was found (normal); only a genuine grab failure sets `error`. The
 *  movie/series paths differ only in the query builder, the match predicate and the
 *  failure event payload — those are passed in, the control flow lives here once. */
export async function searchAndGrabRelease(
  indexers: IndexersService,
  opts: {
    mediaType: "movie" | "series";
    mediaId: string;
    buildQuery: () => string;
    matches: (release: Release) => boolean;
    publishFailure: (error: string) => void;
  },
): Promise<{ grabbed: boolean; release?: Release; error?: string }> {
  const { mediaType, mediaId, buildQuery, matches, publishFailure } = opts;
  const res = await indexers.search({ mediaType, mediaId, query: buildQuery(), limit: 50 });
  if (res.releases.length === 0) return { grabbed: false };
  const candidates = res.releases.filter((r) => matches(r));
  const best = pickBest(candidates.map((r) => r.decision));
  if (!best) return { grabbed: false };
  try {
    await indexers.grab({ mediaType, mediaId, releaseId: best.release.id, indexerId: best.release.indexerId, release: best.release });
    return { grabbed: true, release: best.release };
  } catch (err) {
    const error = (err as Error).message;
    publishFailure(error);
    return { grabbed: false, error };
  }
}
