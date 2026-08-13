// SPDX-License-Identifier: MIT
import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { ApiError } from "@medianexus/shared";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import {
  episodeTarget, movieTarget, parseEpisodeRelease,
  type EpisodeRef, type ExistingFile, type MediaItem, type MediaType,
  type MinimumAvailability, type MovieMediaItem, type Quality,
  type ReleaseTarget, type SeriesMediaItem, type SeriesType,
} from "@medianexus/domain";

/**
 * The single place that turns `movie` / `series` rows into the unified `MediaItem` and
 * resolves a release title into the `ReleaseTarget` it covers.
 *
 * Everything downstream — decisions, import, organiser, history — depends on this
 * instead of branching on mediaType against the raw tables, so the movie and series
 * paths cannot drift the way they did when each service reimplemented the lookup.
 */
@Injectable()
export class MediaRepository {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  // ---------- MediaItem loading ----------

  async find(mediaType: MediaType, mediaId: string): Promise<MediaItem | null> {
    return mediaType === "movie" ? this.findMovie(mediaId) : this.findSeries(mediaId);
  }

  /** Like find(), but throws the standard 404 rather than returning null. */
  async get(mediaType: MediaType, mediaId: string): Promise<MediaItem> {
    const item = await this.find(mediaType, mediaId);
    if (!item) throw ApiError.notFound(mediaType, mediaId);
    return item;
  }

  private async findMovie(id: string): Promise<MovieMediaItem | null> {
    const rows = await this.db.select().from(schema.movie).where(eq(schema.movie.id, id)).limit(1);
    return rows[0] ? toMovieItem(rows[0]) : null;
  }

  private async findSeries(id: string): Promise<SeriesMediaItem | null> {
    const rows = await this.db.select().from(schema.series).where(eq(schema.series.id, id)).limit(1);
    return rows[0] ? toSeriesItem(rows[0]) : null;
  }

  // ---------- Release targeting ----------

  /**
   * Resolve which library entities a release title covers.
   *
   * Movies map one-to-one. For series the season number is part of the key: matching on
   * episode number alone would pull in the same episode number from every other season.
   * A release that parses as episodic but names no episodes is treated as a season pack.
   */
  async resolveTarget(
    mediaType: MediaType,
    mediaId: string,
    releaseTitle: string,
  ): Promise<ReleaseTarget | null> {
    if (mediaType === "movie") return movieTarget(mediaId);

    const match = parseEpisodeRelease(releaseTitle);
    if (match.season === undefined) return null;

    if (match.episodes.length === 0) {
      // Season pack: every episode of that season is a target.
      const episodes = await this.episodesInSeason(mediaId, match.season);
      if (episodes.length === 0) return null;
      return episodeTarget(mediaId, match.season, episodes, true);
    }

    const episodes = await this.episodesByNumber(mediaId, match.season, match.episodes);
    if (episodes.length === 0) return null;
    return episodeTarget(mediaId, match.season, episodes, false);
  }

  async episodesInSeason(seriesId: string, seasonNumber: number): Promise<EpisodeRef[]> {
    const rows = await this.db
      .select({
        id: schema.episode.id,
        seasonNumber: schema.season.seasonNumber,
        episodeNumber: schema.episode.episodeNumber,
        title: schema.episode.title,
        monitored: schema.episode.monitored,
        hasFile: schema.episode.hasFile,
      })
      .from(schema.episode)
      .innerJoin(schema.season, eq(schema.episode.seasonId, schema.season.id))
      .where(and(
        eq(schema.episode.seriesId, seriesId),
        eq(schema.season.seasonNumber, seasonNumber),
      ));
    return rows;
  }

  async episodesByNumber(
    seriesId: string,
    seasonNumber: number,
    episodeNumbers: number[],
  ): Promise<EpisodeRef[]> {
    if (episodeNumbers.length === 0) return [];
    const rows = await this.db
      .select({
        id: schema.episode.id,
        seasonNumber: schema.season.seasonNumber,
        episodeNumber: schema.episode.episodeNumber,
        title: schema.episode.title,
        monitored: schema.episode.monitored,
        hasFile: schema.episode.hasFile,
      })
      .from(schema.episode)
      .innerJoin(schema.season, eq(schema.episode.seasonId, schema.season.id))
      .where(and(
        eq(schema.episode.seriesId, seriesId),
        eq(schema.season.seasonNumber, seasonNumber),
        inArray(schema.episode.episodeNumber, episodeNumbers),
      ));
    return rows;
  }

  // ---------- Existing files (upgrade decisions) ----------

  /** Files already covering a target — the input to "is this release an upgrade?". */
  async existingFiles(target: ReleaseTarget): Promise<ExistingFile[]> {
    const rows = await this.db.select().from(schema.mediaFile).where(and(
      eq(schema.mediaFile.mediaType, target.mediaType),
      eq(schema.mediaFile.mediaId, target.mediaId),
    ));
    const files = rows.map(toExistingFile);
    if (target.kind === "movie") return files;

    const wanted = new Set(target.episodes.map((e) => e.id));
    return files.filter((f) => f.episodeIds.some((id) => wanted.has(id)));
  }
}

// ---------- row mappers ----------

function toMovieItem(row: typeof schema.movie.$inferSelect): MovieMediaItem {
  return {
    id: row.id,
    mediaType: "movie",
    title: row.title,
    year: row.releaseDate ? Number(row.releaseDate.slice(0, 4)) || undefined : undefined,
    overview: row.overview,
    monitored: row.monitored,
    qualityProfileId: row.qualityProfileId,
    rootFolderPath: row.rootFolderPath,
    tags: row.tags ?? [],
    addedAt: row.addedAt,
    tmdbId: row.tmdbId,
    imdbId: row.imdbId,
    releaseDate: row.releaseDate,
    minimumAvailability: row.minimumAvailability as MinimumAvailability,
    hasFile: row.hasFile,
  };
}

function toSeriesItem(row: typeof schema.series.$inferSelect): SeriesMediaItem {
  return {
    id: row.id,
    mediaType: "series",
    title: row.title,
    year: row.firstAirYear ?? undefined,
    overview: row.overview,
    monitored: row.monitored,
    qualityProfileId: row.qualityProfileId,
    rootFolderPath: row.rootFolderPath,
    tags: row.tags ?? [],
    addedAt: row.addedAt,
    tvdbId: row.tvdbId,
    tmdbId: row.tmdbId,
    imdbId: row.imdbId,
    seriesType: row.seriesType as SeriesType,
    network: row.network,
  };
}

function toExistingFile(row: typeof schema.mediaFile.$inferSelect): ExistingFile {
  return {
    id: row.id,
    relativePath: row.relativePath,
    size: row.size,
    quality: (row.quality ?? { source: "unknown", resolution: "unknown", edition: "" }) as Quality,
    episodeIds: row.episodeIds ?? [],
    dateAdded: row.dateAdded,
  };
}
