// SPDX-License-Identifier: MIT
/**
 * MediaFilesService — file-level operations that apply to a `media_file` row regardless of
 * which title it belongs to (FILEMGMT-1, gap report C7). media_file is already the polymorphic
 * (mediaType, mediaId) shape, so one implementation serves both movies and series, matching
 * this project's core "don't write a movie and a series version of the same logic" rule.
 * DELETE disposes the physical file via RecycleBinService (the established single physical-delete
 * call site — never fs/LocalStorageProvider directly); PUT is a metadata-only partial update.
 */
import { Inject, Injectable, Logger } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { join } from "node:path";
import { ApiError } from "@medianexus/shared";
import { schema, type Db } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import { RecycleBinService } from "./recycle-bin.service";
import { toMediaFileRow, fillEpisodeIds, runWrite, type MediaFileRow } from "./media-file.types";

export interface UpdateMediaFileBody {
  quality?: { source: string; resolution: string; edition: string };
  languages?: string[];
  releaseGroup?: string | null;
}

@Injectable()
export class MediaFilesService {
  private readonly logger = new Logger(MediaFilesService.name);
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly recycleBin: RecycleBinService,
  ) {}

  private async getFile(id: string): Promise<typeof schema.mediaFile.$inferSelect> {
    const rows = await this.db.select().from(schema.mediaFile).where(eq(schema.mediaFile.id, id)).limit(1);
    if (!rows[0]) throw ApiError.notFound("media file", id);
    return rows[0];
  }

  /** The owning title's root folder. media_file.relativePath is already root-relative and
   *  includes the title-folder prefix, so a file's absolute path is rootFolderPath +
   *  relativePath — no folder-name is computed here. (The on-disk folder-name convention is
   *  resolved by scan/import via resolvedMovieFolderName/resolvedSeriesFolderName, honoring
   *  the per-title folder_name override — not duplicated in this file, so no second
   *  convention can creep in.) */
  private async resolveTitle(mediaType: "movie" | "series", mediaId: string): Promise<{ rootFolderPath: string }> {
    if (mediaType === "movie") {
      const rows = await this.db.select().from(schema.movie).where(eq(schema.movie.id, mediaId)).limit(1);
      const m = rows[0];
      if (!m) throw ApiError.notFound("movie", mediaId);
      return { rootFolderPath: m.rootFolderPath ?? "" };
    }
    const rows = await this.db.select().from(schema.series).where(eq(schema.series.id, mediaId)).limit(1);
    const s = rows[0];
    if (!s) throw ApiError.notFound("series", mediaId);
    return { rootFolderPath: s.rootFolderPath ?? "" };
  }

  /** DELETE /media-files/:id — dispose the physical file, then remove the DB row. A file that
   *  is already missing on disk must not block the delete (RecycleBinService.move can throw on
   *  a missing source), so the dispose is wrapped and logged — the DB row is still removed.
   *  media_file.relativePath is root-relative and already includes the title-folder prefix, so
   *  the absolute path is rootFolderPath + relativePath (no double folder join). */
  async remove(id: string): Promise<{ removed: boolean }> {
    const f = await this.getFile(id);
    const title = await this.resolveTitle(f.mediaType as "movie" | "series", f.mediaId);
    const absolute = join(title.rootFolderPath, f.relativePath);
    try {
      await this.recycleBin.dispose(absolute);
    } catch (err) {
      this.logger.warn(`Failed to dispose media file ${absolute}: ${(err as Error).message}`);
    }
    await runWrite(this.db, this.db.delete(schema.mediaFile).where(eq(schema.mediaFile.id, id)));
    return { removed: true };
  }

  /** PUT /media-files/:id — metadata-only partial update; omitted fields are untouched
   *  (same "partial body" convention as MoviesService.update/SeriesService.update). */
  async update(id: string, input: UpdateMediaFileBody): Promise<MediaFileRow> {
    const f = await this.getFile(id);
    const set: Partial<typeof schema.mediaFile.$inferInsert> = {};
    if (input.quality !== undefined) set.quality = input.quality;
    if (input.languages !== undefined) set.languages = input.languages;
    if (input.releaseGroup !== undefined) set.releaseGroup = input.releaseGroup;
    await runWrite(this.db, this.db.update(schema.mediaFile).set(set).where(eq(schema.mediaFile.id, f.id)));
    const rows = await this.db.select().from(schema.mediaFile).where(eq(schema.mediaFile.id, f.id)).limit(1);
    const row = toMediaFileRow(rows[0]);
    await fillEpisodeIds(this.db, [row]);
    return row;
  }
}
