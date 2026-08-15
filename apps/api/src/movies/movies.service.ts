// SPDX-License-Identifier: MIT
import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { newEntityId } from "@medianexus/shared";
import { ApiError } from "@medianexus/shared";
import { combine, deletePolymorphicRows, deletePolymorphicRowsAsync, ensureAvailability, listPaged, titleSearchCondition } from "../media/library.helpers";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import type { CreateMovie, MinimumAvailability, UpdateMovieBody } from "@medianexus/domain";
import { hasMinimumAvailability } from "@medianexus/domain";
import { EventsService } from "../events/events.service";
import { EventTypes } from "@medianexus/events";
import { AutoTagsService } from "../auto-tags/auto-tags.service";

export interface ListQuery { search?: string; monitored?: string; sort?: string; page?: number; pageSize?: number }

export interface WantedMovie {
  id: string;
  mediaType: "movie";
  title: string;
  releaseDate: string | null;
  minimumAvailability: MinimumAvailability;
  monitored: boolean;
  hasFile: boolean;
}

@Injectable()
export class MoviesService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly events: EventsService,
    private readonly autoTags: AutoTagsService,
  ) {}

  async list(q: ListQuery) {
    const where = combine([
      titleSearchCondition(schema.movie.title, q.search),
      q.monitored === "true" ? eq(schema.movie.monitored, true) : undefined,
      q.monitored === "false" ? eq(schema.movie.monitored, false) : undefined,
    ]);
    return listPaged<typeof schema.movie.$inferSelect>(this.db, schema.movie, where, q);
  }

  async get(id: string) {
    const rows = await this.db.select().from(schema.movie).where(eq(schema.movie.id, id)).limit(1);
    if (!rows[0]) throw ApiError.notFound("movie", id);
    return rows[0];
  }

  /** Edit a movie (roadmap P1, gap report C5). Partial body; omitted fields are untouched,
   *  `qualityProfileId: null` clears the assignment. Bumps `updatedAt`. */
  async update(id: string, input: UpdateMovieBody) {
    const existing = await this.get(id);
    const merged = {
      title: input.title ?? existing.title,
      monitored: input.monitored ?? existing.monitored,
      qualityProfileId: input.qualityProfileId !== undefined ? input.qualityProfileId : existing.qualityProfileId,
      rootFolderPath: input.rootFolderPath ?? existing.rootFolderPath,
      minimumAvailability: input.minimumAvailability ?? existing.minimumAvailability,
      tags: input.tags ?? existing.tags,
    };
    const updatedAt = new Date().toISOString();
    const tags = await this.autoTags.appliedTags({
      tags: merged.tags,
      genres: existing.genres ?? [],
      status: existing.status,
      monitored: merged.monitored,
      rootFolderPath: merged.rootFolderPath,
      qualityProfileId: merged.qualityProfileId,
      year: existing.releaseDate ? Number(existing.releaseDate.slice(0, 4)) : null,
    });
    await this.db.update(schema.movie).set({ ...merged, tags, updatedAt }).where(eq(schema.movie.id, id));
    return { ...existing, ...merged, tags, updatedAt };
  }

  async create(input: CreateMovie) {
    if (input.tmdbId) {
      const dup = await this.db.select().from(schema.movie).where(eq(schema.movie.tmdbId, input.tmdbId)).limit(1);
      if (dup[0]) throw new ApiError({ code: "CONFLICT", message: `Movie with tmdbId ${input.tmdbId} already exists` });
    }
    const now = new Date().toISOString();
    const id = newEntityId("m");
    const row = {
      id,
      tmdbId: input.tmdbId ?? null,
      imdbId: input.imdbId ?? null,
      title: input.title,
      originalTitle: null,
      overview: input.overview ?? "",
      status: input.releaseDate ? "released" : "unknown",
      releaseDate: input.releaseDate ?? null,
      monitored: input.monitored ?? true,
      qualityProfileId: input.qualityProfileId ?? null,
      rootFolderPath: input.rootFolderPath ?? "",
      minimumAvailability: input.minimumAvailability,
      genres: [],
      images: [],
      tags: input.tags ?? [],
      hasFile: false,
      addedAt: now,
      updatedAt: now,
    };
    // Auto-tag (roadmap P3, gap C6): fold rule-based tag changes into the same insert, so a new
    // movie gets its auto tags in one atomic write (no second write/event).
    row.tags = await this.autoTags.appliedTags({
      tags: row.tags,
      genres: row.genres ?? [],
      status: row.status,
      monitored: row.monitored,
      rootFolderPath: row.rootFolderPath,
      qualityProfileId: row.qualityProfileId,
      year: row.releaseDate ? Number(row.releaseDate.slice(0, 4)) : null,
    });
    await this.db.insert(schema.movie).values(row);
    await this.upsertAvailability("movie", id);
    this.events.publish(EventTypes.MovieAdded, { movieId: id, title: row.title }, { aggType: "movie", aggId: id });
    return row;
  }

  async remove(id: string) {
    const row = await this.get(id);
    if (this.db.dbDialect === "postgres") {
      // better-sqlite3's native tx wrapper needs a sync callback; node-postgres needs async
      // (P2 item 12 Stage 2) — two irreconcilable signatures, so Postgres gets its own body.
      await this.db.transaction(async (tx) => {
        await deletePolymorphicRowsAsync(tx, "movie", id);
        await tx.delete(schema.movie).where(eq(schema.movie.id, id));
        if (row.tmdbId != null) {
          await tx.insert(schema.importExclusion).values({
            id: `excl-movie-${row.tmdbId}`, mediaType: "movie", externalId: String(row.tmdbId),
            reason: "removed from library", createdAt: new Date().toISOString(),
          }).onConflictDoNothing();
        }
      });
    } else {
      this.db.transaction((tx) => {
        deletePolymorphicRows(tx, "movie", id);
        tx.delete(schema.movie).where(eq(schema.movie.id, id)).run();
        // C2 import lists: a manually-removed title is excluded from re-import by the next
        // list sync (idempotent; best-effort, only when it has a stable external id).
        if (row.tmdbId != null) {
          tx.insert(schema.importExclusion).values({
            id: `excl-movie-${row.tmdbId}`, mediaType: "movie", externalId: String(row.tmdbId),
            reason: "removed from library", createdAt: new Date().toISOString(),
          }).onConflictDoNothing().run();
        }
      });
    }
    this.events.publish(EventTypes.MovieRemoved, { movieId: id }, { aggType: "movie", aggId: id });
    return { removed: id };
  }

  async upsertAvailability(mediaType: "movie" | "series", mediaId: string): Promise<void> {
    await ensureAvailability(this.db, mediaType, mediaId);
  }

  /** Want/Missing: monitored movies without a file, past their minimum-availability gate
   *  (roadmap C1). The gate depends on Date.now(), so it can't be pushed into SQL —
   *  overfetch past `limit` and filter in JS, mirroring the shape of
   *  SeriesService.wantedMissing(). */
  async wantedMissing(limit = 50): Promise<WantedMovie[]> {
    const rows = await this.db.select().from(schema.movie)
      .where(and(eq(schema.movie.monitored, true), eq(schema.movie.hasFile, false)))
      .orderBy(asc(schema.movie.releaseDate))
      .limit(Math.max(limit * 4, 200));
    return rows
      .filter((m) => hasMinimumAvailability({ minimumAvailability: m.minimumAvailability as MinimumAvailability, releaseDate: m.releaseDate }))
      .slice(0, limit)
      .map((m) => ({
        id: m.id, mediaType: "movie" as const, title: m.title, releaseDate: m.releaseDate,
        minimumAvailability: m.minimumAvailability as MinimumAvailability, monitored: m.monitored, hasFile: m.hasFile,
      }));
  }
}
