// SPDX-License-Identifier: MIT
/**
 * Shared wire shape + mapper for media_file rows (DETAILPAGE-FE1). Both the movie and series
 * `/files` endpoints expose exactly this, so the movie File panel and the series season-size
 * computation share one source of truth. The DB stores `media_info` as a raw JSON blob; this
 * mapper normalizes it onto the precise MediaInfo fields (codec/resolution/… ) the detail-page
 * UI reads, and flattens the blob-carrying columns onto clean, nullable-but-typed fields.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { MediaInfo } from "@medianexus/domain";
import { schema } from "@medianexus/database";
import type { Db } from "@medianexus/database";

/** Execute a drizzle write query on the given DB. `.run()` is SQLite-only (better-sqlite3);
 *  a Postgres-backed instance is a NodePgDatabase with no `.run()` at all (P2 item 12 Stage 2).
 *  The `Db` type is SQLite-shaped so typecheck passes either way — this branch is what keeps a
 *  write from throwing `TypeError: .run is not a function` on a real Postgres connection. */
export async function runWrite(db: Db, q: { run: () => unknown }): Promise<void> {
  if (db.dbDialect === "postgres") {
    await (q as unknown as Promise<unknown>);
  } else {
    q.run();
  }
}

export interface MediaFileRow {
  id: string;
  mediaType: "movie" | "series";
  mediaId: string;
  episodeIds: string[];
  relativePath: string;
  size: number;
  quality: { source: string; resolution: string; edition: string } | null;
  mediaInfo: MediaInfo | null;
  languages: string[];
  releaseGroup: string | null;
  dateAdded: string | null;
  /** Custom formats this file currently matches, recomputed live against the CURRENT
   *  custom-format definitions at read time (never a frozen snapshot — see attachMatchedFormats).
   *  Left `[]` by toMediaFileRow; only the /files endpoints populate it. */
  matchedFormats: { id: string; name: string }[];
}

type RawMediaFileRow = {
  id: string;
  mediaType: string;
  mediaId: string;
  relativePath: string;
  size: number;
  quality: unknown;
  mediaInfo: unknown;
  languages: unknown;
  releaseGroup: string | null;
  dateAdded: string | null;
};

/** Map a raw DB row onto the clean MediaFileRow shape (null-safe for the JSON columns).
 *  `episodeIds` is a placeholder ([]) here — callers must run the rows through
 *  `fillEpisodeIds` to populate it from the FK inverse (roadmap J3). */
export function toMediaFileRow<T extends RawMediaFileRow>(row: T): MediaFileRow {
  return {
    id: row.id,
    mediaType: row.mediaType as "movie" | "series",
    mediaId: row.mediaId,
    episodeIds: [],
    relativePath: row.relativePath,
    size: row.size,
    quality: (row.quality && typeof row.quality === "object" ? row.quality : null) as MediaFileRow["quality"],
    mediaInfo: (row.mediaInfo && typeof row.mediaInfo === "object" ? row.mediaInfo : null) as MediaFileRow["mediaInfo"],
    languages: Array.isArray(row.languages) ? (row.languages as string[]) : [],
    releaseGroup: row.releaseGroup ?? null,
    dateAdded: row.dateAdded,
    matchedFormats: [],
  };
}

/** Fill each returned file's `episodeIds` from `episode.media_file_id` — the indexed FK inverse
 *  of the now-dropped `media_file.episode_ids` JSON column (roadmap J3). An episode whose file
 *  was later superseded still points only at its current (authoritative) file, so a surviving
 *  partially-superseded file reports only the episodes it genuinely covers. Deterministic
 *  ordering by episode id. */
export async function fillEpisodeIds(db: Db, files: MediaFileRow[]): Promise<MediaFileRow[]> {
  if (files.length === 0) return files;
  const byFile = new Map<string, string[]>();
  const rows = await db
    .select({ id: schema.episode.id, fileId: schema.episode.mediaFileId })
    .from(schema.episode)
    .where(inArray(schema.episode.mediaFileId, files.map((f) => f.id)))
    .orderBy(asc(schema.episode.id));
  for (const e of rows) {
    if (e.fileId === null) continue;
    const list = byFile.get(e.fileId);
    if (list) list.push(e.id);
    else byFile.set(e.fileId, [e.id]);
  }
  for (const f of files) f.episodeIds = byFile.get(f.id) ?? [];
  return files;
}

/** Query a title's media_file rows and map them onto MediaFileRow (shared by movies + series).
 *  The /files endpoints, series rename and acquisition all go through here, so the wire
 *  `episodeIds` array is derived one way from the FK join. */
export async function selectMediaFiles(db: Db, mediaType: "movie" | "series", mediaId: string): Promise<MediaFileRow[]> {
  const rows = await db
    .select()
    .from(schema.mediaFile)
    .where(and(eq(schema.mediaFile.mediaType, mediaType), eq(schema.mediaFile.mediaId, mediaId)));
  return fillEpisodeIds(db, rows.map(toMediaFileRow));
}
