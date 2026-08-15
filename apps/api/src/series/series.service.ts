// SPDX-License-Identifier: MIT
import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { deletePolymorphicRows, ensureAvailability, listPaged, titleSearchCondition } from "../media/library.helpers";
import { ApiError, newEntityId } from "@medianexus/shared";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import type { CreateSeries, UpdateSeriesBody } from "@medianexus/domain";
import { EventsService } from "../events/events.service";
import { EventTypes } from "@medianexus/events";

@Injectable()
export class SeriesService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly events: EventsService,
  ) {}

  async list(q: { search?: string; page?: number; pageSize?: number }) {
    const where = titleSearchCondition(schema.series.title, q.search);
    return listPaged<typeof schema.series.$inferSelect>(this.db, schema.series, where, q);
  }

  async get(id: string) {
    const rows = await this.db.select().from(schema.series).where(eq(schema.series.id, id)).limit(1);
    if (!rows[0]) throw ApiError.notFound("series", id);
    return rows[0];
  }

  /** Edit a series (roadmap P1, gap report C5). Partial body; omitted fields untouched,
   *  `qualityProfileId: null` clears the assignment. Bumps `updatedAt`. */
  async update(id: string, input: UpdateSeriesBody) {
    const existing = await this.get(id);
    const merged = {
      title: input.title ?? existing.title,
      monitored: input.monitored ?? existing.monitored,
      seriesType: input.seriesType ?? existing.seriesType,
      qualityProfileId: input.qualityProfileId !== undefined ? input.qualityProfileId : existing.qualityProfileId,
      rootFolderPath: input.rootFolderPath ?? existing.rootFolderPath,
      tags: input.tags ?? existing.tags,
    };
    const updatedAt = new Date().toISOString();
    await this.db.update(schema.series).set({ ...merged, updatedAt }).where(eq(schema.series.id, id));
    return { ...existing, ...merged, updatedAt };
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
      tmdbId: input.tmdbId ?? null,
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
    // Not fire-and-forget: swallowing this left series with no availability row, which
    // in turn made every later availability update a silent no-op.
    await ensureAvailability(this.db, "series", id);
    this.events.publish(EventTypes.SeriesAdded, { seriesId: id, title: row.title }, { aggType: "series", aggId: id });
    return row;
  }

  async seasons(seriesId: string) {
    await this.get(seriesId);
    return this.db.select().from(schema.season).where(eq(schema.season.seriesId, seriesId)).orderBy(sql`${schema.season.seasonNumber} asc`);
  }

  async remove(id: string) {
    const row = await this.get(id);
    // Only the polymorphic tables need a hand-written delete here — season/episode cascade
    // automatically via their DB-level FK to series (roadmap P0.7) once the series row
    // itself is deleted.
    this.db.transaction((tx) => {
      deletePolymorphicRows(tx, "series", id);
      tx.delete(schema.series).where(eq(schema.series.id, id)).run();
      // C2 import lists: a manually-removed title is excluded from re-import by the next
      // list sync (idempotent; best-effort, only when it has a stable external id).
      if (row.tmdbId != null) {
        tx.insert(schema.importExclusion).values({
          id: `excl-series-${row.tmdbId}`, mediaType: "series", externalId: String(row.tmdbId),
          reason: "removed from library", createdAt: new Date().toISOString(),
        }).onConflictDoNothing().run();
      }
    });
    this.events.publish(EventTypes.SeriesRemoved, { seriesId: id }, { aggType: "series", aggId: id });
    return { removed: id };
  }

  // ---------- episodes (M2) ----------

  async episodes(seriesId: string, season?: number) {
    await this.get(seriesId);
    const conds = [eq(schema.episode.seriesId, seriesId)];
    if (season !== undefined) conds.push(eq(schema.season.seasonNumber, season));
    return this.db
      .select({ episode: schema.episode, seasonNumber: schema.season.seasonNumber })
      .from(schema.episode)
      .innerJoin(schema.season, eq(schema.episode.seasonId, schema.season.id))
      .where(and(...conds))
      .orderBy(asc(schema.season.seasonNumber), asc(schema.episode.episodeNumber));
  }

  /** Bulk-create episodes for a season (metadata import will automate this; manual endpoint for now). */
  async createEpisodes(seriesId: string, input: { seasonNumber: number; episodeNumbers: number[]; title?: string; airDateUtc?: string }) {
    await this.get(seriesId);
    const season = await this.db.select().from(schema.season)
      .where(and(eq(schema.season.seriesId, seriesId), eq(schema.season.seasonNumber, input.seasonNumber))).limit(1);
    const seasonId = season[0]?.id;
    if (!seasonId) throw new ApiError({ code: "UNPROCESSABLE", message: `Season ${input.seasonNumber} doesn't exist for this series` });
    const created = [];
    for (const n of input.episodeNumbers) {
      const epId = newEntityId("ep");
      await this.db.insert(schema.episode).values({
        id: epId,
        seriesId,
        seasonId,
        episodeNumber: n,
        title: input.title ? `${input.title}` : "",
        airDateUtc: input.airDateUtc ?? null,
        monitored: true,
        hasFile: false,
      }).onConflictDoNothing();
      created.push(epId);
    }
    return { created: created.length, episodeIds: created };
  }

  async setEpisodeMonitored(seriesId: string, episodeId: string, monitored: boolean) {
    await this.get(seriesId);
    const rows = await this.db.select().from(schema.episode)
      .where(and(eq(schema.episode.id, episodeId), eq(schema.episode.seriesId, seriesId))).limit(1);
    if (!rows[0]) throw ApiError.notFound("episode", episodeId);
    await this.db.update(schema.episode).set({ monitored }).where(eq(schema.episode.id, episodeId));
    return this.db.select().from(schema.episode).where(eq(schema.episode.id, episodeId)).limit(1);
  }

  /**
   * Monitor/unmonitor a season (roadmap P1, gap report C5 — season monitoring was the
   * specific unreachable gap). Crucially this also cascades `monitored` to EVERY episode
   * in the season: `wantedMissing()`/RSS match on `episode.monitored`, and
   * `season.monitored` is otherwise never read (gap-report J7 dead-config), so a season
   * toggle that only touched the season row would change nothing. Matching upstream Sonarr,
   * where monitoring a season applies to all its episodes.
   */
  async setSeasonMonitored(seriesId: string, seasonId: string, monitored: boolean) {
    await this.get(seriesId);
    const seasonRows = await this.db.select().from(schema.season)
      .where(and(eq(schema.season.id, seasonId), eq(schema.season.seriesId, seriesId))).limit(1);
    if (!seasonRows[0]) throw ApiError.notFound("season", seasonId);
    this.db.transaction((tx) => {
      tx.update(schema.season).set({ monitored }).where(eq(schema.season.id, seasonId)).run();
      tx.update(schema.episode).set({ monitored }).where(eq(schema.episode.seasonId, seasonId)).run();
    });
    return (await this.db.select().from(schema.season).where(eq(schema.season.id, seasonId)).limit(1))[0];
  }

  /** Want/Missing: monitored episodes without a file yet (all series). */
  async wantedMissing(limit = 50) {
    const rows = await this.db
      .select({
        episode: schema.episode,
        seasonNumber: schema.season.seasonNumber,
        series: { id: schema.series.id, title: schema.series.title, seriesType: schema.series.seriesType, alternateTitles: schema.series.alternateTitles },
      })
      .from(schema.episode)
      .innerJoin(schema.season, eq(schema.episode.seasonId, schema.season.id))
      .innerJoin(schema.series, eq(schema.episode.seriesId, schema.series.id))
      .where(and(eq(schema.episode.monitored, true), eq(schema.episode.hasFile, false)))
      .orderBy(asc(schema.episode.airDateUtc))
      .limit(limit);
    return rows.map((r) => ({ ...r.episode, seasonNumber: r.seasonNumber, seriesTitle: r.series.title, seriesType: r.series.seriesType, seriesAlternateTitles: r.series.alternateTitles ?? [] }));
  }

  /** Calendar: upcoming episodes with air dates in [start, end] (default next 14 days). */
  async calendar(startIso?: string, endIso?: string) {
    const start = startIso ?? new Date().toISOString();
    const end = endIso ?? new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
    const rows = await this.db
      .select({
        episode: schema.episode,
        seasonNumber: schema.season.seasonNumber,
        series: { id: schema.series.id, title: schema.series.title },
      })
      .from(schema.episode)
      .innerJoin(schema.season, eq(schema.episode.seasonId, schema.season.id))
      .innerJoin(schema.series, eq(schema.episode.seriesId, schema.series.id))
      .where(and(sql`${schema.episode.airDateUtc} IS NOT NULL`, gte(sql`${schema.episode.airDateUtc}`, start), lte(sql`${schema.episode.airDateUtc}`, end)))
      .orderBy(asc(schema.episode.airDateUtc))
      .limit(200);
    return rows.map((r) => ({ id: r.episode.id, seriesId: r.series.id, seriesTitle: r.series.title, seasonNumber: r.seasonNumber, episodeNumber: r.episode.episodeNumber, title: r.episode.title, airDateUtc: r.episode.airDateUtc, hasFile: r.episode.hasFile, monitored: r.episode.monitored }));
  }
}
