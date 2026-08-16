// SPDX-License-Identifier: MIT
/**
 * Shared wire shape + mapper for media_file rows (DETAILPAGE-FE1). Both the movie and series
 * `/files` endpoints expose exactly this, so the movie File panel and the series season-size
 * computation share one source of truth. The DB stores `media_info` as a raw JSON blob; this
 * mapper normalizes it onto the precise MediaInfo fields (codec/resolution/… ) the detail-page
 * UI reads, and flattens the blob-carrying columns onto clean, nullable-but-typed fields.
 */
import { and, eq } from "drizzle-orm";
import type { MediaInfo } from "@medianexus/domain";
import { schema } from "@medianexus/database";
import type { Db } from "@medianexus/database";

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
  dateAdded: string | null;
}

type RawMediaFileRow = {
  id: string;
  mediaType: string;
  mediaId: string;
  episodeIds: unknown;
  relativePath: string;
  size: number;
  quality: unknown;
  mediaInfo: unknown;
  languages: unknown;
  dateAdded: string | null;
};

/** Map a raw DB row onto the clean MediaFileRow shape (null-safe for the JSON columns). */
export function toMediaFileRow<T extends RawMediaFileRow>(row: T): MediaFileRow {
  return {
    id: row.id,
    mediaType: row.mediaType as "movie" | "series",
    mediaId: row.mediaId,
    episodeIds: Array.isArray(row.episodeIds) ? (row.episodeIds as string[]) : [],
    relativePath: row.relativePath,
    size: row.size,
    quality: (row.quality && typeof row.quality === "object" ? row.quality : null) as MediaFileRow["quality"],
    mediaInfo: (row.mediaInfo && typeof row.mediaInfo === "object" ? row.mediaInfo : null) as MediaFileRow["mediaInfo"],
    languages: Array.isArray(row.languages) ? (row.languages as string[]) : [],
    dateAdded: row.dateAdded,
  };
}

/** Query a title's media_file rows and map them onto MediaFileRow (shared by movies + series). */
export async function selectMediaFiles(db: Db, mediaType: "movie" | "series", mediaId: string): Promise<MediaFileRow[]> {
  const rows = await db
    .select()
    .from(schema.mediaFile)
    .where(and(eq(schema.mediaFile.mediaType, mediaType), eq(schema.mediaFile.mediaId, mediaId)));
  return rows.map(toMediaFileRow as (r: unknown) => MediaFileRow);
}
