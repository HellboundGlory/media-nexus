// SPDX-License-Identifier: MIT
import { Inject, Injectable } from "@nestjs/common";
import { desc, eq, sql } from "drizzle-orm";
import { ApiError, newEntityId } from "@medianexus/shared";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import type { CreateSeries } from "@medianexus/domain";
import { EventsService } from "../events/events.service";
import { EventTypes } from "@medianexus/events";

@Injectable()
export class SeriesService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly events: EventsService,
  ) {}

  async list(q: { search?: string; page?: number; pageSize?: number }) {
    const search = q.search?.trim();
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, q.pageSize ?? 50));
    const where = search ? sql`lower(${schema.series.title}) like ${`%${search.toLowerCase()}%`}` : undefined;
    const [rows, totals] = await Promise.all([
      this.db.select().from(schema.series).where(where).orderBy(desc(schema.series.addedAt)).limit(pageSize).offset((page - 1) * pageSize),
      this.db.select({ n: sql<number>`count(*)` }).from(schema.series).where(where),
    ]);
    return { items: rows, total: Number(totals[0]?.n ?? 0), page, pageSize };
  }

  async get(id: string) {
    const rows = await this.db.select().from(schema.series).where(eq(schema.series.id, id)).limit(1);
    if (!rows[0]) throw ApiError.notFound("series", id);
    return rows[0];
  }

  async create(input: CreateSeries) {
    if (input.tvdbId) {
      const dup = await this.db.select().from(schema.series).where(eq(schema.series.tvdbId, input.tvdbId)).limit(1);
      if (dup[0]) throw new ApiError({ code: "CONFLICT", message: `Series with tvdbId ${input.tvdbId} already exists` });
    }
    const now = new Date().toISOString();
    const id = newEntityId("s");
    const row = {
      id,
      tvdbId: input.tvdbId ?? null,
      imdbId: input.imdbId ?? null,
      title: input.title,
      overview: input.overview ?? "",
      status: "unknown",
      seriesType: input.seriesType ?? "standard",
      network: null,
      firstAirYear: input.firstAirYear ?? null,
      monitored: input.monitored ?? true,
      qualityProfileId: input.qualityProfileId ?? null,
      rootFolderPath: input.rootFolderPath ?? "",
      genres: [],
      images: [],
      tags: input.tags ?? [],
      addedAt: now,
      updatedAt: now,
    };
    await this.db.insert(schema.series).values(row);
    // create season rows for seasons 0 and 1 (extended by metadata import in M2)
    for (const seasonNumber of [0, 1]) {
      await this.db.insert(schema.season).values({
        id: newEntityId("sea"),
        seriesId: id,
        seasonNumber,
        monitored: true,
      });
    }
    await this.db.insert(schema.mediaAvailability).values({
      id: newEntityId("av"), mediaType: "series", mediaId: id, status: "unknown",
    }).catch(() => {});
    this.events.publish(EventTypes.SeriesAdded, { seriesId: id, title: row.title }, { aggType: "series", aggId: id });
    return row;
  }

  async seasons(seriesId: string) {
    await this.get(seriesId);
    return this.db.select().from(schema.season).where(eq(schema.season.seriesId, seriesId)).orderBy(sql`${schema.season.seasonNumber} asc`);
  }

  async remove(id: string) {
    await this.get(id);
    await this.db.delete(schema.series).where(eq(schema.series.id, id));
    this.events.publish(EventTypes.SeriesRemoved, { seriesId: id }, { aggType: "series", aggId: id });
    return { removed: id };
  }
}
