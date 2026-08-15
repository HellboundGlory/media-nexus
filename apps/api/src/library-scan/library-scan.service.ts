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
  decideImportFile, type MediaType, type Quality, type KnownEpisode, type SeriesType,
} from "@medianexus/domain";
import { LocalStorageProvider, findAllVideos } from "@medianexus/integrations";
import { MediaRepository } from "../media/media.repository";
import { ensureAvailabilitySync, getQualityProfile, type Tx } from "../media/library.helpers";
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
    const surviving: typeof existing = [];
    const stale: typeof existing = [];
    for (const f of existing) {
      const abs = join(movie.rootFolderPath, f.relativePath);
      (existsSync(abs) ? surviving : stale).push(f);
    }

    const folder = join(movie.rootFolderPath, movieFolderName(movie.title, movie.releaseDate));
    const files = await findAllVideos(this.storage, folder);
    const trackedPaths = new Set(surviving.map((f) => join(movie.rootFolderPath, f.relativePath)));
    const untracked = files.filter((f) => !trackedPaths.has(f.path));

    // Scan reconciles; it doesn't proactively reorganize. If a valid tracked file already
    // exists, an untracked sibling (a leftover extra, a sample) is left alone rather than
    // guessed at — grabbing an upgrade is a decision-engine (P0.3) job, not a scan job.
    let newFile: { mediaFileId: string; relativePath: string; size: number; quality: Quality } | null = null;
    if (surviving.length === 0 && untracked.length > 0) {
      const best = untracked[0]; // findAllVideos returns largest first
      newFile = {
        mediaFileId: newEntityId("mf"),
        relativePath: relative(movie.rootFolderPath, best.path),
        size: statSyncSafe(best.path),
        quality: parseQualityFromTitle(baseNameOf(best.path)),
      };
    }

    const filesAdded = newFile ? 1 : 0;
    const filesRemoved = stale.length;
    const hasFile = surviving.length > 0 || filesAdded > 0;
    const now = new Date().toISOString();

    // One transaction for the whole title: the stale-row deletes, the new-file insert, the
    // hasFile flip and the availability update either all land or none do.
    this.db.transaction((tx) => {
      for (const f of stale) tx.delete(schema.mediaFile).where(eq(schema.mediaFile.id, f.id)).run();
      if (newFile) {
        tx.insert(schema.mediaFile).values({
          id: newFile.mediaFileId, mediaType: "movie", mediaId: movie.id, episodeIds: [],
          relativePath: newFile.relativePath, size: newFile.size, quality: newFile.quality, dateAdded: now,
        }).run();
      }
      if (hasFile !== movie.hasFile) {
        tx.update(schema.movie).set({ hasFile, updatedAt: now }).where(eq(schema.movie.id, movie.id)).run();
      }
      if (filesAdded > 0 || filesRemoved > 0) this.markAvailabilitySync(tx, "movie", movie.id, now);
    });
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
      const surviving: typeof existing = [];
      const staleThisSeason: typeof existing = [];
      for (const f of existing) {
        const abs = join(root, f.relativePath);
        (existsSync(abs) ? surviving : staleThisSeason).push(f);
      }
      filesRemoved += staleThisSeason.length;

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
        const fname = baseNameOf(file.path);
        const match = parseEpisodeRelease(fname);
        let episodesInFile = match.episodes;
        // Daily/anime files name a date or absolute number instead of S&E (episodes stay
        // empty in the pure parse). Resolve them against the series' own numbering and
        // keep only episodes belonging to the season dir currently being scanned.
        if (series.seriesType !== "standard" && episodesInFile.length === 0
          && (match.dailyDate !== undefined || match.absoluteNumber !== undefined)) {
          const resolved = await this.media.resolveEpisodeTargets(series.seriesType as SeriesType, seriesId, match);
          episodesInFile = (resolved?.episodes ?? [])
            .filter((e) => e.seasonNumber === season.seasonNumber)
            .map((e) => e.episodeNumber);
        }
        const quality = parseQualityFromTitle(fname);
        const decision = decideImportFile(file, episodesInFile, knownEpisodes, quality, profile);
        if (decision.approved && decision.episodeIds.length > 0) {
          approved.push({ path: file.path, size: file.size, episodeIds: decision.episodeIds, quality });
        }
      }
      filesAdded += approved.length;

      const newlyCovered = new Set(approved.flatMap((a) => a.episodeIds));
      // Same upgrade-replace rule as P0.5's import: an old file is removed only once every
      // episode it covered has a newly-found replacement this scan.
      const supersededOld = surviving.filter((f) => f.episodeIds.length > 0 && f.episodeIds.every((id) => newlyCovered.has(id)));

      const coveredEpisodeIds = new Set(newlyCovered);
      const supersededIds = new Set(supersededOld.map((f) => f.id));
      for (const f of surviving) {
        if (supersededIds.has(f.id)) continue; // superseded above
        for (const id of f.episodeIds) coveredEpisodeIds.add(id);
      }

      // One transaction per season, matching the granularity the reconciliation loop
      // already treats each season at: a failure scanning a later season must not roll
      // back an earlier season's already-applied changes.
      this.db.transaction((tx) => {
        for (const f of staleThisSeason) tx.delete(schema.mediaFile).where(eq(schema.mediaFile.id, f.id)).run();
        for (const f of supersededOld) tx.delete(schema.mediaFile).where(eq(schema.mediaFile.id, f.id)).run();
        for (const a of approved) {
          tx.insert(schema.mediaFile).values({
            id: newEntityId("mf"), mediaType: "series", mediaId: seriesId, episodeIds: a.episodeIds,
            relativePath: relative(root, a.path), size: a.size, quality: a.quality, dateAdded: new Date().toISOString(),
          }).run();
        }
        for (const ep of seasonEpisodes) {
          const hasFile = coveredEpisodeIds.has(ep.id);
          if (hasFile !== ep.hasFile) {
            tx.update(schema.episode).set({ hasFile }).where(eq(schema.episode.id, ep.id)).run();
          }
        }
      });
    }

    if (filesAdded > 0 || filesRemoved > 0) {
      const now = new Date().toISOString();
      this.db.transaction((tx) => this.markAvailabilitySync(tx, "series", seriesId, now));
    }
    return { filesFound, filesAdded, filesRemoved };
  }

  private markAvailabilitySync(tx: Tx, mediaType: MediaType, mediaId: string, now: string): void {
    const status = mediaType === "movie" ? "available" : this.seriesAvailabilitySync(tx, mediaId);
    ensureAvailabilitySync(tx, mediaType, mediaId);
    tx.update(schema.mediaAvailability)
      .set({ status, lastAvailabilitySyncAt: now })
      .where(and(eq(schema.mediaAvailability.mediaType, mediaType), eq(schema.mediaAvailability.mediaId, mediaId)))
      .run();
  }

  private seriesAvailabilitySync(tx: Tx, seriesId: string): "available" | "partially_available" {
    const eps = tx.select({ hasFile: schema.episode.hasFile, monitored: schema.episode.monitored })
      .from(schema.episode).where(eq(schema.episode.seriesId, seriesId)).all();
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
