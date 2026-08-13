// SPDX-License-Identifier: MIT
import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { join, relative } from "node:path";
import { existsSync, statSync } from "node:fs";
import { newEntityId } from "@medianexus/shared";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import {
  movieTarget, episodeTarget, parseQualityFromTitle, parseEpisodeRelease, compareQuality,
  decideImportFile, type MediaType, type Quality, type KnownEpisode,
} from "@medianexus/domain";
import { LocalStorageProvider, findAllVideos } from "@medianexus/integrations";
import { MediaRepository } from "../media/media.repository";
import { ensureAvailability, getQualityProfile } from "../media/library.helpers";
import { movieFolderName, seriesFolderName } from "../media/naming.helpers";
import { EventsService } from "../events/events.service";
import { EventTypes } from "@medianexus/events";

export interface ScanResult {
  filesFound: number;
  filesAdded: number;
  filesRemoved: number;
}

const EMPTY_RESULT: ScanResult = { filesFound: 0, filesAdded: 0, filesRemoved: 0 };

/**
 * Disk scan (roadmap P0.6, gap report B3): before this, the app only knew about files it
 * imported itself. Point it at an existing library — including one brought across by the
 * upstream DB importer (`apps/api/src/import/upstream/`), which copies series/episode/movie
 * rows but writes zero `media_file` rows — and every title read as missing forever.
 *
 * Scoped deliberately (see the P0.5 handoff this follows): reconciles files for
 * *already-added* titles against *their own* `rootFolderPath`, using the same
 * `movieFolderName()`/`seriesFolderName()` convention the import engine writes to (P0.5) —
 * the same "Title (Year)" shape *arr apps already default to, so a migrated library whose
 * folders follow that common convention is found. This does **not** browse a root folder
 * for entirely new, unadded titles nobody told the app about — that needs a real root-folder
 * entity (gap report B8, still open) and is out of scope here.
 *
 * Series scanning reuses `decideImportFile()` (P0.5) exactly as import does — a file
 * already sitting on disk is decided the same way a freshly-downloaded one is (episode
 * matching, upgrade/cutoff), just without a transfer step. An old row is only deleted once
 * every episode it covered has a newly-found replacement, the same rule P0.5 uses.
 */
@Injectable()
export class LibraryScanService implements OnModuleInit {
  private readonly logger = new Logger(LibraryScanService.name);
  private readonly storage = new LocalStorageProvider();

  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly media: MediaRepository,
    private readonly events: EventsService,
  ) {}

  /** Scan a newly-added title automatically — covers a user adding a title whose files are
   *  already sitting in its configured root folder. Does NOT cover the upstream importer,
   *  which writes rows directly and never publishes these events — that path relies on the
   *  scheduled job or an explicit on-demand scan after importing. */
  onModuleInit(): void {
    this.events.subscribe(EventTypes.MovieAdded, async (event) => {
      const movieId = (event.payload as { movieId?: string }).movieId;
      if (movieId) await this.scanMovie(movieId).catch((err) => this.logger.warn(`on-add scan failed for movie ${movieId}: ${(err as Error).message}`));
    });
    this.events.subscribe(EventTypes.SeriesAdded, async (event) => {
      const seriesId = (event.payload as { seriesId?: string }).seriesId;
      if (seriesId) await this.scanSeries(seriesId).catch((err) => this.logger.warn(`on-add scan failed for series ${seriesId}: ${(err as Error).message}`));
    });
  }

  async scanMedia(mediaType: MediaType, mediaId: string): Promise<ScanResult> {
    return mediaType === "movie" ? this.scanMovie(mediaId) : this.scanSeries(mediaId);
  }

  /** Scan every movie and series. Per-title isolation: one title's scan failing must not
   *  abort the rest — same principle as AcquisitionService.syncAll(). */
  async scanAll(): Promise<{ movies: number; series: number; filesAdded: number; filesRemoved: number }> {
    const movies = await this.db.select({ id: schema.movie.id }).from(schema.movie);
    const seriesRows = await this.db.select({ id: schema.series.id }).from(schema.series);
    let filesAdded = 0;
    let filesRemoved = 0;
    for (const m of movies) {
      try {
        const r = await this.scanMovie(m.id);
        filesAdded += r.filesAdded; filesRemoved += r.filesRemoved;
      } catch (err) {
        this.logger.warn(`scan failed for movie ${m.id}: ${(err as Error).message}`);
      }
    }
    for (const s of seriesRows) {
      try {
        const r = await this.scanSeries(s.id);
        filesAdded += r.filesAdded; filesRemoved += r.filesRemoved;
      } catch (err) {
        this.logger.warn(`scan failed for series ${s.id}: ${(err as Error).message}`);
      }
    }
    return { movies: movies.length, series: seriesRows.length, filesAdded, filesRemoved };
  }

  async scanMovie(movieId: string): Promise<ScanResult> {
    const rows = await this.db.select().from(schema.movie).where(eq(schema.movie.id, movieId)).limit(1);
    const movie = rows[0];
    if (!movie || !movie.rootFolderPath) return EMPTY_RESULT;

    const target = movieTarget(movie.id);
    const existing = await this.media.existingFiles(target);
    let filesRemoved = 0;
    const surviving = [];
    for (const f of existing) {
      const abs = join(movie.rootFolderPath, f.relativePath);
      if (existsSync(abs)) { surviving.push(f); continue; }
      await this.db.delete(schema.mediaFile).where(eq(schema.mediaFile.id, f.id));
      filesRemoved++;
    }

    const folder = join(movie.rootFolderPath, movieFolderName(movie.title, movie.releaseDate));
    const files = await findAllVideos(this.storage, folder);
    const trackedPaths = new Set(surviving.map((f) => join(movie.rootFolderPath, f.relativePath)));
    const untracked = files.filter((f) => !trackedPaths.has(f.path));

    // Scan reconciles; it doesn't proactively reorganize. If a valid tracked file already
    // exists, an untracked sibling (a leftover extra, a sample) is left alone rather than
    // guessed at — grabbing an upgrade is a decision-engine (P0.3) job, not a scan job.
    let filesAdded = 0;
    if (surviving.length === 0 && untracked.length > 0) {
      const best = untracked[0]; // findAllVideos returns largest first
      const quality = parseQualityFromTitle(baseNameOf(best.path));
      const mediaFileId = newEntityId("mf");
      await this.db.insert(schema.mediaFile).values({
        id: mediaFileId, mediaType: "movie", mediaId: movie.id, episodeIds: [],
        relativePath: relative(movie.rootFolderPath, best.path), size: statSyncSafe(best.path),
        quality, dateAdded: new Date().toISOString(),
      });
      filesAdded = 1;
    }

    const hasFile = surviving.length > 0 || filesAdded > 0;
    if (hasFile !== movie.hasFile) {
      await this.db.update(schema.movie).set({ hasFile, updatedAt: new Date().toISOString() }).where(eq(schema.movie.id, movie.id));
    }
    if (filesAdded > 0 || filesRemoved > 0) await this.markAvailability("movie", movie.id);
    return { filesFound: files.length, filesAdded, filesRemoved };
  }

  async scanSeries(seriesId: string): Promise<ScanResult> {
    const rows = await this.db.select().from(schema.series).where(eq(schema.series.id, seriesId)).limit(1);
    const series = rows[0];
    if (!series || !series.rootFolderPath) return EMPTY_RESULT;

    const seasons = await this.db.select().from(schema.season).where(eq(schema.season.seriesId, seriesId));
    const profile = await getQualityProfile(this.db, series.qualityProfileId);
    const safeSeries = seriesFolderName(series.title);
    const root = series.rootFolderPath;

    let filesFound = 0, filesAdded = 0, filesRemoved = 0;

    for (const season of seasons) {
      const seasonEpisodes = await this.media.episodesInSeason(seriesId, season.seasonNumber);
      if (seasonEpisodes.length === 0) continue;

      const target = episodeTarget(seriesId, season.seasonNumber, seasonEpisodes, true);
      const existing = await this.media.existingFiles(target);
      const surviving = [];
      for (const f of existing) {
        const abs = join(root, f.relativePath);
        if (existsSync(abs)) { surviving.push(f); continue; }
        await this.db.delete(schema.mediaFile).where(eq(schema.mediaFile.id, f.id));
        filesRemoved++;
      }

      const bestExistingByEpisode = new Map<string, Quality>();
      for (const f of surviving) {
        for (const epId of f.episodeIds) {
          const cur = bestExistingByEpisode.get(epId);
          if (!cur || compareQuality(f.quality, cur) > 0) bestExistingByEpisode.set(epId, f.quality);
        }
      }
      const knownEpisodes = new Map<number, KnownEpisode>(
        seasonEpisodes.map((e) => [e.episodeNumber, { id: e.id, existingQuality: bestExistingByEpisode.get(e.id) ?? null }]),
      );

      const seasonDir = join(root, safeSeries, `Season ${season.seasonNumber}`);
      const files = await findAllVideos(this.storage, seasonDir);
      filesFound += files.length;
      const trackedPaths = new Set(surviving.map((f) => join(root, f.relativePath)));
      const untracked = files.filter((f) => !trackedPaths.has(f.path));

      const approved: { path: string; size: number; episodeIds: string[]; quality: Quality }[] = [];
      for (const file of untracked) {
        const episodesInFile = parseEpisodeRelease(baseNameOf(file.path)).episodes;
        const quality = parseQualityFromTitle(baseNameOf(file.path));
        const decision = decideImportFile(file, episodesInFile, knownEpisodes, quality, profile);
        if (decision.approved && decision.episodeIds.length > 0) {
          approved.push({ path: file.path, size: file.size, episodeIds: decision.episodeIds, quality });
        }
      }

      const newlyCovered = new Set(approved.flatMap((a) => a.episodeIds));
      // Same upgrade-replace rule as P0.5's import: an old file is removed only once every
      // episode it covered has a newly-found replacement this scan.
      for (const f of surviving) {
        if (f.episodeIds.length > 0 && f.episodeIds.every((id) => newlyCovered.has(id))) {
          await this.db.delete(schema.mediaFile).where(eq(schema.mediaFile.id, f.id));
        }
      }

      for (const a of approved) {
        const mediaFileId = newEntityId("mf");
        await this.db.insert(schema.mediaFile).values({
          id: mediaFileId, mediaType: "series", mediaId: seriesId, episodeIds: a.episodeIds,
          relativePath: relative(root, a.path), size: a.size, quality: a.quality, dateAdded: new Date().toISOString(),
        });
      }
      filesAdded += approved.length;

      const coveredEpisodeIds = new Set(newlyCovered);
      for (const f of surviving) {
        if (f.episodeIds.length > 0 && f.episodeIds.every((id) => newlyCovered.has(id))) continue; // superseded above
        for (const id of f.episodeIds) coveredEpisodeIds.add(id);
      }
      for (const ep of seasonEpisodes) {
        const hasFile = coveredEpisodeIds.has(ep.id);
        if (hasFile !== ep.hasFile) {
          await this.db.update(schema.episode).set({ hasFile }).where(eq(schema.episode.id, ep.id));
        }
      }
    }

    if (filesAdded > 0 || filesRemoved > 0) await this.markAvailability("series", seriesId);
    return { filesFound, filesAdded, filesRemoved };
  }

  private async markAvailability(mediaType: MediaType, mediaId: string): Promise<void> {
    const now = new Date().toISOString();
    const status = mediaType === "movie" ? "available" : await this.seriesAvailability(mediaId);
    await ensureAvailability(this.db, mediaType, mediaId);
    await this.db.update(schema.mediaAvailability)
      .set({ status, lastAvailabilitySyncAt: now })
      .where(and(eq(schema.mediaAvailability.mediaType, mediaType), eq(schema.mediaAvailability.mediaId, mediaId)));
  }

  private async seriesAvailability(seriesId: string): Promise<"available" | "partially_available"> {
    const eps = await this.db.select({ hasFile: schema.episode.hasFile, monitored: schema.episode.monitored })
      .from(schema.episode).where(eq(schema.episode.seriesId, seriesId));
    const missing = eps.some((e) => e.monitored && !e.hasFile);
    return missing ? "partially_available" : "available";
  }
}

function baseNameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function statSyncSafe(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}
