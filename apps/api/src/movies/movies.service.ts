// SPDX-License-Identifier: MIT
import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { newEntityId } from "@medianexus/shared";
import { ApiError } from "@medianexus/shared";
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
    const search = q.search?.trim();
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, q.pageSize ?? 50));
    const conds = [];
    if (search) conds.push(sql`lower(${schema.movie.title}) like ${`%${search.toLowerCase()}%`}`);
    if (q.monitored === "true") conds.push(eq(schema.movie.monitored, true));
    if (q.monitored === "false") conds.push(eq(schema.movie.monitored, false));
    const where = conds.length ? and(...conds) : undefined;

    const [rows, totals] = await Promise.all([
      this.db.select().from(schema.movie).where(where).orderBy(desc(schema.movie.addedAt)).limit(pageSize).offset((page - 1) * pageSize),
      this.db.select({ n: sql<number>`count(*)` }).from(schema.movie).where(where),
    ]);
    return { items: rows, total: Number(totals[0]?.n ?? 0), page, pageSize };
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
    const existing = await this.db.select().from(schema.mediaAvailability)
      .where(sql`${schema.mediaAvailability.mediaType} = ${mediaType} AND ${schema.mediaAvailability.mediaId} = ${mediaId}`).limit(1);
    if (existing.length) return;
    await this.db.insert(schema.mediaAvailability).values({
      id: newEntityId("av"),
      mediaType,
      mediaId,
      status: "unknown",
    });
  }
}
