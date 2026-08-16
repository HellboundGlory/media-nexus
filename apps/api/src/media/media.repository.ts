// SPDX-License-Identifier: MIT
import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { ApiError } from "@medianexus/shared";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import {
  episodeTarget, movieTarget, parseEpisodeRelease,
  type EpisodeRef, type EpisodeReleaseMatch, type ExistingFile, type MediaItem, type MediaType,
  type MinimumAvailability, type MovieMediaItem, type Quality,
  type ReleaseTarget, type SeriesMediaItem, type SeriesType,
} from "@medianexus/domain";
import { fillEpisodeIds, toMediaFileRow } from "./media-file.types";

/** One entry in the media-neutral calendar (roadmap P3 "calendar iCal export"): either an episode
 *  airing or a movie release, discriminated on `mediaType`. The JSON feed and the .ics export both
 *  consume this. */
export type CalendarEntry =
  | {
      mediaType: "episode";
      id: string;
      seriesId: string;
      seriesTitle: string;
      seasonNumber: number;
      episodeNumber: number;
      title: string;
      airDateUtc: string;
      hasFile: boolean;
      monitored: boolean;
    }
  | {
      mediaType: "movie";
      movieId: string;
      movieTitle: string;
      releaseDate: string;
      hasFile: boolean;
      monitored: boolean;
    };

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
   * Movies map one-to-one. For series the resolution dispatches on the series' own
   * `seriesType` (the release parser is media-agnostic and reports every signal it can —
   * S&E, date, absolute — so the DB-aware layer here picks the numbering scheme that
   * applies): standard → S&E (with a scene-number inversion fallback), daily → air date
   * (S&E secondary), anime → absolute number (S&E secondary). A release that parses as
   * episodic but names no episodes is treated as a season pack.
   */
  async resolveTarget(
    mediaType: MediaType,
    mediaId: string,
    releaseTitle: string,
  ): Promise<ReleaseTarget | null> {
    if (mediaType === "movie") return movieTarget(mediaId);

    const series = await this.findSeries(mediaId);
    if (!series) return null;

    const match = parseEpisodeRelease(releaseTitle);
    const res = await this.resolveEpisodeTargets(series.seriesType, series.id, match);
    if (!res) return null;
    return episodeTarget(mediaId, res.seasonNumber, res.episodes, res.isSeasonPack);
  }

  /**
   * The shared episode-resolution core used by `resolveTarget` (and the RSS/series paths)
   * so the numbering schemes can't drift between call sites. Returns the season + the
   * covered episodes, or null when nothing resolves. Always graceful on absent data:
   * a daily/anime series with null `airDateUtc`/`absoluteNumber`/scene columns simply
   * yields no match rather than erroring.
   */
  async resolveEpisodeTargets(
    seriesType: SeriesType,
    seriesId: string,
    match: EpisodeReleaseMatch,
  ): Promise<{ seasonNumber: number; episodes: EpisodeRef[]; isSeasonPack: boolean } | null> {
    if (seriesType === "daily") {
      if (match.dailyDate) {
        const eps = await this.episodesByAirDate(seriesId, match.dailyDate);
        if (eps.length) return { seasonNumber: eps[0].seasonNumber, episodes: eps, isSeasonPack: false };
      }
      return this.resolveBySeasonEpisode(seriesId, match, "secondary");
    }

    if (seriesType === "anime") {
      if (match.absoluteNumber !== undefined) {
        const eps = await this.episodesByAbsoluteNumber(seriesId, match.absoluteNumber);
        if (eps.length) return { seasonNumber: eps[0].seasonNumber, episodes: eps, isSeasonPack: false };
      }
      return this.resolveBySeasonEpisode(seriesId, match, "secondary");
    }

    // standard
    return this.resolveBySeasonEpisode(seriesId, match, "primary");
  }

  /** S&E + season-pack resolution; for standard it also falls back to scene-number
   *  inversion. `mode` marks whether S&E is the primary scheme (standard) or a secondary
   *  fallback once the daily/anime primary returned nothing. */
  private async resolveBySeasonEpisode(
    seriesId: string,
    match: EpisodeReleaseMatch,
    _mode: "primary" | "secondary",
  ): Promise<{ seasonNumber: number; episodes: EpisodeRef[]; isSeasonPack: boolean } | null> {
    if (match.season === undefined) return null;

    if (match.episodes.length === 0) {
      // Season pack: every episode of that season is a target.
      const episodes = await this.episodesInSeason(seriesId, match.season);
      if (episodes.length === 0) return null;
      return { seasonNumber: match.season, episodes, isSeasonPack: true };
    }

    const episodes = await this.episodesByNumber(seriesId, match.season, match.episodes);
    if (episodes.length > 0) return { seasonNumber: match.season, episodes, isSeasonPack: false };

    // Scene-number inversion fallback (standard only): a release's S&E may use scene
    // numbering that differs from TVDB. When the direct episodeNumber lookup returns
    // nothing, look for the TVDB episode whose scene S&E matches the parsed S&E.
    const scene = await this.episodesBySceneNumber(seriesId, match.season, match.episodes);
    if (scene.length === 0) return null;
    return { seasonNumber: scene[0].seasonNumber, episodes: scene, isSeasonPack: false };
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

  /** Episodes whose airDateUtc falls on `date` ("YYYY-MM-DD"). Exact day first; only when
   *  nothing matches exactly does it fall back to ±1 day (timezone / re-air drift). This
   *  keeps back-to-back daily episodes (each on its own day) resolving to exactly one
   *  episode instead of pulling in neighbours. Empty when the series has no dated episodes —
   *  daily matching degrades gracefully instead of erroring on null air dates. */
  async episodesByAirDate(seriesId: string, date: string): Promise<EpisodeRef[]> {
    const rows = await this.db
      .select({
        id: schema.episode.id,
        seasonNumber: schema.season.seasonNumber,
        episodeNumber: schema.episode.episodeNumber,
        title: schema.episode.title,
        monitored: schema.episode.monitored,
        hasFile: schema.episode.hasFile,
        airDateUtc: schema.episode.airDateUtc,
      })
      .from(schema.episode)
      .innerJoin(schema.season, eq(schema.episode.seasonId, schema.season.id))
      .where(eq(schema.episode.seriesId, seriesId));
    const byDay = rows.filter((r) => r.airDateUtc).map((r) => ({ ...r, day: r.airDateUtc!.slice(0, 10) }));
    const exact = byDay.filter((r) => r.day === date);
    const pick = exact.length > 0 ? exact : byDay.filter((r) => {
      const t = new Date(r.day + "T00:00:00.000Z").getTime();
      const base = new Date(`${date}T00:00:00.000Z`).getTime();
      return Math.abs(t - base) <= 86400000;
    });
    return pick.map((r) => ({ id: r.id, seasonNumber: r.seasonNumber, episodeNumber: r.episodeNumber, title: r.title, monitored: r.monitored, hasFile: r.hasFile }));
  }

  /** Episodes with a matching absolute (anime) number, across ALL seasons. */
  async episodesByAbsoluteNumber(seriesId: string, absoluteNumber: number): Promise<EpisodeRef[]> {
    return this.db
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
        eq(schema.episode.absoluteNumber, absoluteNumber),
      ));
  }

  /** Episodes whose scene S&E numbers invert to the given scene season/episodes. */
  async episodesBySceneNumber(seriesId: string, sceneSeason: number, sceneEpisodes: number[]): Promise<EpisodeRef[]> {
    if (sceneEpisodes.length === 0) return [];
    return this.db
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
        eq(schema.episode.sceneSeasonNumber, sceneSeason),
        inArray(schema.episode.sceneEpisodeNumber, sceneEpisodes),
      ));
  }

  // ---------- Existing files (upgrade decisions) ----------

  /** Files already covering a target — the input to "is this release an upgrade?". */
  async existingFiles(target: ReleaseTarget): Promise<ExistingFile[]> {
    if (target.kind === "movie") {
      const rows = await this.db.select().from(schema.mediaFile).where(and(
        eq(schema.mediaFile.mediaType, target.mediaType),
        eq(schema.mediaFile.mediaId, target.mediaId),
      ));
      // A movie file covers no episodes — its episodeIds is always empty.
      return rows.map((r) => toExistingFile(r, []));
    }

    // Series branch (roadmap J3 finishes the migration): answer "which of this series' files cover
    // these wanted episode ids" through the indexed `episode.media_file_id` FK — now the ONLY source
    // of coverage truth (the old `media_file.episode_ids` JSON column is gone).
    const wanted = target.episodes.map((e) => e.id);
    if (wanted.length === 0) return [];
    // The join is filtered to `wanted`, so it is used only to decide WHICH files cover a wanted
    // episode. It must not also derive each file's `episodeIds`: that would truncate a file's
    // coverage to the wanted subset, whereas the FK's honest answer is the file's true full
    // coverage. (Today every caller passes a full season's episodes, so no truncation occurs,
    // but a future partial-subset caller would silently get a wrong answer.)
    const matched = await this.db
      .select()
      .from(schema.mediaFile)
      .innerJoin(schema.episode, eq(schema.episode.mediaFileId, schema.mediaFile.id))
      .where(and(
        eq(schema.mediaFile.mediaType, target.mediaType),
        eq(schema.mediaFile.mediaId, target.mediaId),
        inArray(schema.episode.id, wanted),
      ));
    if (matched.length === 0) return [];
    const fileById = new Map<string, typeof schema.mediaFile.$inferSelect>();
    for (const { media_file } of matched) fileById.set(media_file.id, media_file);
    // Derive each matched file's `episodeIds` from its true full FK coverage (unfiltered by
    // `wanted`), in episode-id order — the same one-place derivation fillEpisodeIds performs.
    const rawFiles = [...fileById.values()];
    const rows = await fillEpisodeIds(this.db, rawFiles.map(toMediaFileRow));
    const episodeIdsById = new Map(rows.map((r) => [r.id, r.episodeIds]));
    return rawFiles.map((row) => toExistingFile(row, episodeIdsById.get(row.id) ?? []));
  }

  // ---------- Calendar (media-neutral) ----------

  /**
   * Media-neutral calendar: episode air dates AND movie release dates in [start, end], merged into
   * one date-sorted discriminated union (roadmap P3 "calendar iCal export"). Both the JSON feed
   * and the .ics export share this. Fixes the discovered gap where the calendar previously excluded
   * movies entirely (only the episode/season/series join) — Radarr shows movie release dates, and a
   * real unified calendar should show both. LocalDates are bounded to [start,end]: episodes compare
   * on full air_date_utc; movies carry only a date (release_date), so they compare on the date part.
   */
  async calendar(startIso?: string, endIso?: string): Promise<CalendarEntry[]> {
    const start = startIso ?? new Date().toISOString();
    const end = endIso ?? new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();

    const [episodes, movies] = await Promise.all([
      this.db
        .select({
          episode: schema.episode,
          seasonNumber: schema.season.seasonNumber,
          seriesId: schema.series.id,
          seriesTitle: schema.series.title,
        })
        .from(schema.episode)
        .innerJoin(schema.season, eq(schema.episode.seasonId, schema.season.id))
        .innerJoin(schema.series, eq(schema.episode.seriesId, schema.series.id))
        .where(and(
          sql`${schema.episode.airDateUtc} IS NOT NULL`,
          gte(sql`${schema.episode.airDateUtc}`, start),
          lte(sql`${schema.episode.airDateUtc}`, end),
        ))
        .limit(200),
      this.db
        .select({
          movieId: schema.movie.id,
          movieTitle: schema.movie.title,
          releaseDate: schema.movie.releaseDate,
          hasFile: schema.movie.hasFile,
          monitored: schema.movie.monitored,
        })
        .from(schema.movie)
        .where(and(
          sql`${schema.movie.releaseDate} IS NOT NULL`,
          gte(sql`${schema.movie.releaseDate}`, start.slice(0, 10)),
          lte(sql`${schema.movie.releaseDate}`, end.slice(0, 10)),
        ))
        .limit(200),
    ]);

    const list: CalendarEntry[] = [
      ...episodes.map((r) => ({
        mediaType: "episode" as const,
        id: r.episode.id,
        seriesId: r.seriesId,
        seriesTitle: r.seriesTitle,
        seasonNumber: r.seasonNumber,
        episodeNumber: r.episode.episodeNumber,
        title: r.episode.title,
        airDateUtc: r.episode.airDateUtc ?? "",
        hasFile: r.episode.hasFile,
        monitored: r.episode.monitored,
      })),
      ...movies.map((r) => ({
        mediaType: "movie" as const,
        movieId: r.movieId,
        movieTitle: r.movieTitle,
        releaseDate: r.releaseDate ?? "",
        hasFile: r.hasFile,
        monitored: r.monitored,
      })),
    ];
    list.sort((a, b) => {
      const da = a.mediaType === "episode" ? a.airDateUtc : a.releaseDate;
      const db = b.mediaType === "episode" ? b.airDateUtc : b.releaseDate;
      return da.localeCompare(db);
    });
    return list;
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
    alternateTitles: row.alternateTitles ?? [],
  };
}

function toExistingFile(row: typeof schema.mediaFile.$inferSelect, episodeIds: string[]): ExistingFile {
  return {
    id: row.id,
    relativePath: row.relativePath,
    size: row.size,
    quality: (row.quality ?? { source: "unknown", resolution: "unknown", edition: "" }) as Quality,
    episodeIds,
    dateAdded: row.dateAdded,
  };
}
