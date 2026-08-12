// SPDX-License-Identifier: MIT
import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { newEntityId } from "@medianexus/shared";
import { ApiError } from "@medianexus/shared";
import { combine, ensureAvailability, listPaged, titleSearchCondition } from "../media/library.helpers";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import type { CreateMovie } from "@medianexus/domain";
import { EventsService } from "../events/events.service";
import { EventTypes } from "@medianexus/events";

export interface ListQuery { search?: string; monitored?: string; sort?: string; page?: number; pageSize?: number }

@Injectable()
export class MoviesService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly events: EventsService,
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
      minimumAvailability: "announced",
      genres: [],
      images: [],
      tags: input.tags ?? [],
      hasFile: false,
      addedAt: now,
      updatedAt: now,
    };
    await this.db.insert(schema.movie).values(row);
    await this.upsertAvailability("movie", id);
    this.events.publish(EventTypes.MovieAdded, { movieId: id, title: row.title }, { aggType: "movie", aggId: id });
    return row;
  }

  async remove(id: string) {
    await this.get(id);
    await this.db.delete(schema.movie).where(eq(schema.movie.id, id));
    this.events.publish(EventTypes.MovieRemoved, { movieId: id }, { aggType: "movie", aggId: id });
    return { removed: id };
  }

  async upsertAvailability(mediaType: "movie" | "series", mediaId: string): Promise<void> {
    await ensureAvailability(this.db, mediaType, mediaId);
  }
}
