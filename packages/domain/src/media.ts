// SPDX-License-Identifier: MIT
/**
 * The unified media abstraction.
 *
 * Movies and series stay separate tables — their identity, metadata source and file
 * cardinality genuinely differ — but almost everything downstream of "what should we
 * grab and where does the file go" does not care which one it is holding. That shared
 * infrastructure (decision engine, import engine, organiser, queue, history) is written
 * against `MediaItem` and `ReleaseTarget` rather than against two parallel branches.
 *
 *   MediaItem
 *     ├─ movie   (tmdbId, minimumAvailability, releaseDate)
 *     └─ series  (tvdbId, seriesType, network) → Season → Episode
 *
 *   ReleaseTarget — what a specific release is *for*
 *     ├─ movie    { movieId }
 *     └─ episode  { seriesId, episodes[], isSeasonPack }
 */
import { z } from "zod";
import type { MediaType } from "./media-type";
import type { Quality } from "./quality";

// ---------------------------------------------------------------------------
// MediaItem — the normalized view of a library title
// ---------------------------------------------------------------------------

/** Fields every library title has, whatever its media type. */
export interface MediaItemBase {
  id: string;
  mediaType: MediaType;
  title: string;
  /** release year (movies) or first-air year (series); undefined when unknown */
  year?: number;
  overview: string;
  monitored: boolean;
  qualityProfileId: string | null;
  rootFolderPath: string;
  tags: string[];
  addedAt: string;
}

export interface MovieMediaItem extends MediaItemBase {
  mediaType: "movie";
  tmdbId: number | null;
  imdbId: string | null;
  releaseDate: string | null;
  minimumAvailability: MinimumAvailability;
  hasFile: boolean;
}

export interface SeriesMediaItem extends MediaItemBase {
  mediaType: "series";
  tvdbId: number | null;
  tmdbId: number | null;
  imdbId: string | null;
  seriesType: SeriesType;
  network: string | null;
}

export type MediaItem = MovieMediaItem | SeriesMediaItem;

export const minimumAvailabilitySchema = z.enum([
  "announced", "in_cinemas", "released", "deleted",
]);
export type MinimumAvailability = z.infer<typeof minimumAvailabilitySchema>;

export const seriesTypeValues = ["standard", "daily", "anime"] as const;
export type SeriesType = (typeof seriesTypeValues)[number];

export function isMovieItem(item: MediaItem): item is MovieMediaItem {
  return item.mediaType === "movie";
}

export function isSeriesItem(item: MediaItem): item is SeriesMediaItem {
  return item.mediaType === "series";
}

/** Stable "(mediaType, mediaId)" pointer — the polymorphic key used across the schema. */
export interface MediaRef {
  mediaType: MediaType;
  mediaId: string;
}

export function mediaRef(item: MediaItem): MediaRef {
  return { mediaType: item.mediaType, mediaId: item.id };
}

/** Human label used in logs, history and notifications. */
export function mediaLabel(item: MediaItem): string {
  return item.year ? `${item.title} (${item.year})` : item.title;
}

// ---------------------------------------------------------------------------
// ReleaseTarget — what a release is for
// ---------------------------------------------------------------------------

/** A single episode a release may cover. */
export interface EpisodeRef {
  id: string;
  seasonNumber: number;
  episodeNumber: number;
  monitored: boolean;
  hasFile: boolean;
}

export interface MovieReleaseTarget {
  kind: "movie";
  mediaType: "movie";
  mediaId: string;
}

export interface EpisodeReleaseTarget {
  kind: "episode";
  mediaType: "series";
  mediaId: string;
  seasonNumber: number;
  episodes: EpisodeRef[];
  /** true when the release covers a whole season rather than named episodes */
  isSeasonPack: boolean;
}

export type ReleaseTarget = MovieReleaseTarget | EpisodeReleaseTarget;

export function movieTarget(movieId: string): MovieReleaseTarget {
  return { kind: "movie", mediaType: "movie", mediaId: movieId };
}

export function episodeTarget(
  seriesId: string,
  seasonNumber: number,
  episodes: EpisodeRef[],
  isSeasonPack = false,
): EpisodeReleaseTarget {
  return { kind: "episode", mediaType: "series", mediaId: seriesId, seasonNumber, episodes, isSeasonPack };
}

export function targetRef(target: ReleaseTarget): MediaRef {
  return { mediaType: target.mediaType, mediaId: target.mediaId };
}

/** Episode ids a target covers; empty for movie targets. */
export function targetEpisodeIds(target: ReleaseTarget): string[] {
  return target.kind === "episode" ? target.episodes.map((e) => e.id) : [];
}

/** True when nothing the target covers has a file yet. */
export function targetIsMissing(target: ReleaseTarget, movieHasFile = false): boolean {
  if (target.kind === "movie") return !movieHasFile;
  return target.episodes.every((e) => !e.hasFile);
}

/** True when at least one thing the target covers is monitored. */
export function targetIsMonitored(target: ReleaseTarget, movieMonitored = true): boolean {
  if (target.kind === "movie") return movieMonitored;
  return target.episodes.some((e) => e.monitored);
}

// ---------------------------------------------------------------------------
// Existing-file view — what the target already has, for upgrade decisions
// ---------------------------------------------------------------------------

/** A file already in the library covering some part of a target. */
export interface ExistingFile {
  id: string;
  relativePath: string;
  size: number;
  quality: Quality;
  episodeIds: string[];
  dateAdded: string;
}

// ---------------------------------------------------------------------------
// Minimum availability — the movie-side gate on when searching may begin
// ---------------------------------------------------------------------------

/**
 * Whether a movie has reached the availability its profile requires. Radarr gates all
 * searching on this; without it, automation grabs cams for films that are still in
 * production. `physicalRelease`/`digitalRelease` are not modelled yet, so `released`
 * falls back to the primary release date.
 */
export function hasMinimumAvailability(
  movie: Pick<MovieMediaItem, "minimumAvailability" | "releaseDate">,
  now = new Date(),
): boolean {
  if (movie.minimumAvailability === "announced") return true;
  if (movie.minimumAvailability === "deleted") return true;
  if (!movie.releaseDate) return false;
  const released = new Date(movie.releaseDate);
  if (Number.isNaN(released.getTime())) return false;
  return released.getTime() <= now.getTime();
}
