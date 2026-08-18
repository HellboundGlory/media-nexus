// SPDX-License-Identifier: MIT
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, eq, inArray } from "drizzle-orm";
import { ApiError } from "@medianexus/shared";
import { schema, type Db } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import { MetadataService } from "../metadata/metadata.service";
import { MoviesService } from "../movies/movies.service";

export interface UpdateCollectionBody {
  monitored?: boolean;
  /** Omitted = unchanged; null = clear the profile. */
  qualityProfileId?: string | null;
  rootFolderPath?: string;
  minimumAvailability?: string;
  searchOnAdd?: boolean;
}

/**
 * Collections (UNI-021): TMDB movie collections as a real tracked entity.
 *
 * Modeled on the Import Lists subsystem. A `collection` row is auto-upserted the first time a
 * movie with that collectionTmdbId is added/refreshed, and is unmonitored by default. ONE Monitor
 * toggle per collection: turning it ON marks every already-owned part monitored right now AND
 * enables future auto-add of missing parts via the recurring sync; OFF only stops future auto-add
 * (it never unmonitors owned movies). Parts are a denormalized JSON column on `collection`
 * (ownership recomputed on each sync); missing-count is parts with inLibrary false.
 */
@Injectable()
export class CollectionsService {
  private readonly logger = new Logger(CollectionsService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly metadata: MetadataService,
    private readonly movies: MoviesService,
  ) {}

  async list() {
    const rows = await this.db.select().from(schema.collection).orderBy(asc(schema.collection.name));
    return rows.map((r) => ({ ...r, missingCount: (r.parts ?? []).filter((p) => !p.inLibrary).length }));
  }

  async update(id: string, patch: UpdateCollectionBody) {
    const rows = await this.db.select().from(schema.collection).where(eq(schema.collection.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw ApiError.notFound("collection", id);
    const now = new Date().toISOString();
    const merged = {
      monitored: patch.monitored ?? row.monitored,
      qualityProfileId: patch.qualityProfileId !== undefined ? patch.qualityProfileId : row.qualityProfileId,
      rootFolderPath: patch.rootFolderPath ?? row.rootFolderPath,
      minimumAvailability: patch.minimumAvailability ?? row.minimumAvailability,
      searchOnAdd: patch.searchOnAdd ?? row.searchOnAdd,
      updatedAt: now,
    };
    await this.db.update(schema.collection).set(merged).where(eq(schema.collection.id, id));

    // Decision 2: turning Monitor ON marks movies you already own in this collection as monitored
    // right now (a single batched update across the owned parts' movie ids). Turning it OFF never
    // unmonitors existing movies.
    if (patch.monitored === true && row.monitored !== true) {
      const ownedIds = (row.parts ?? [])
        .filter((p) => p.inLibrary && p.libraryId)
        .map((p) => p.libraryId as string);
      if (ownedIds.length) {
        await this.db.update(schema.movie).set({ monitored: true, updatedAt: now }).where(inArray(schema.movie.id, ownedIds));
      }
    }
    return { ...row, ...merged };
  }

  /** Bulk action (UNI-020 pattern): fan out over update() per id, aggregating per-id
   *  success/failure so one bad id never silently aborts the batch. */
  async bulkEdit(ids: string[], patch: UpdateCollectionBody) {
    const updated: string[] = [];
    const failed: { id: string; error: string }[] = [];
    for (const id of ids) {
      try { await this.update(id, patch); updated.push(id); }
      catch (err) { failed.push({ id, error: (err as Error).message }); }
    }
    return { updated, failed };
  }

  private async isExcluded(externalId: string): Promise<boolean> {
    const rows = await this.db.select({ id: schema.importExclusion.id }).from(schema.importExclusion)
      .where(and(eq(schema.importExclusion.mediaType, "movie"), eq(schema.importExclusion.externalId, externalId))).limit(1);
    return rows.length > 0;
  }

  /** Refresh a collection's parts from TMDB and, when monitored, auto-add any missing parts
   *  (via addFromDiscover — the only correct add path — skipping import_exclusion so something the
   *  user removed doesn't silently come back). Returns added/missing counts. */
  async sync(id: string): Promise<{ monitored: boolean; added: number; missing: number }> {
    const rows = await this.db.select().from(schema.collection).where(eq(schema.collection.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw ApiError.notFound("collection", id);
    const now = new Date().toISOString();
    const info = await this.metadata.getCollectionInfo(row.tmdbId);
    await this.db.update(schema.collection).set({
      name: info.name, overview: info.overview, images: info.images, parts: info.parts, lastSyncAt: now, updatedAt: now,
    }).where(eq(schema.collection.id, id));

    let added = 0;
    if (row.monitored) {
      for (const part of info.parts) {
        if (part.inLibrary) continue;
        if (await this.isExcluded(String(part.tmdbId))) continue;
        try {
          const res = await this.metadata.addFromDiscover("movie", part.tmdbId, {
            monitored: true, qualityProfileId: row.qualityProfileId ?? undefined, rootFolderPath: row.rootFolderPath,
            minimumAvailability: row.minimumAvailability as "announced" | "in_cinemas" | "released" | "deleted",
          });
          // searchOnAdd: best-effort grab for a newly added part — a failed search shouldn't fail the sync.
          if (res.created && row.searchOnAdd) {
            await this.movies.autoSearchMovie(res.id).catch(() => undefined);
          }
          added++;
        } catch (err) {
          this.logger.warn(`collection "${row.name}" part ${part.tmdbId} add failed: ${(err as Error).message}`);
        }
      }
      // Recompute ownership after adds so the stored parts / missing-count reflect them now, not
      // on the next scheduled sync.
      if (added > 0) {
        const fresh = await this.metadata.getCollectionInfo(row.tmdbId);
        await this.db.update(schema.collection).set({ parts: fresh.parts, updatedAt: new Date().toISOString() }).where(eq(schema.collection.id, id));
        return { monitored: true, added, missing: fresh.parts.filter((p) => !p.inLibrary).length };
      }
    }
    return { monitored: row.monitored, added, missing: info.parts.filter((p) => !p.inLibrary).length };
  }

  /** Sync every collection (the `media.collectionSync` job). One bad collection can't abort the rest. */
  async syncAll(): Promise<{ collections: number; added: number; failed: number }> {
    const cols = await this.db.select().from(schema.collection);
    let added = 0;
    let failed = 0;
    for (const c of cols) {
      try { added += (await this.sync(c.id)).added; }
      catch (err) { failed++; this.logger.error(`collection "${c.name}" sync failed: ${(err as Error).message}`); }
    }
    return { collections: cols.length, added, failed };
  }

  /** On-demand single-part add (the mockup's "+" on a missing poster): add that one movie, then
   *  re-sync so the collection's parts/missing-count reflect the change immediately. */
  async addPart(collectionId: string, tmdbId: number): Promise<{ added: boolean; tmdbId: number }> {
    const rows = await this.db.select().from(schema.collection).where(eq(schema.collection.id, collectionId)).limit(1);
    const row = rows[0];
    if (!row) throw ApiError.notFound("collection", collectionId);
    await this.metadata.addFromDiscover("movie", tmdbId, {
      monitored: row.monitored, qualityProfileId: row.qualityProfileId ?? undefined, rootFolderPath: row.rootFolderPath,
      minimumAvailability: row.minimumAvailability as "announced" | "in_cinemas" | "released" | "deleted",
    });
    await this.sync(collectionId);
    return { added: true, tmdbId };
  }
}
