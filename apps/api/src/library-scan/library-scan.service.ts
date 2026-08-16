// SPDX-License-Identifier: MIT
import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { join, relative } from "node:path";
import { existsSync } from "node:fs";
import { newEntityId } from "@medianexus/shared";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import {
  movieTarget, episodeTarget, parseQualityFromTitle, parseEpisodeRelease, compareQuality,
  decideImportFile, type MediaType, type Quality, type KnownEpisode, type SeriesType,
  type ImportRejection,
} from "@medianexus/domain";
import { LocalStorageProvider, findAllVideos } from "@medianexus/integrations";
import { MediaRepository } from "../media/media.repository";
import { ensureAvailabilitySync, ensureAvailabilityTx, getQualityProfile, type Tx } from "../media/library.helpers";
import { resolvedMovieFolderName, resolvedSeriesFolderName } from "../media/naming.helpers";
import { EventsService } from "../events/events.service";
import { EventTypes } from "@medianexus/events";

export interface ScanResult {
  filesFound: number;
  filesAdded: number;
  filesRemoved: number;
}

const EMPTY_RESULT: ScanResult = { filesFound: 0, filesAdded: 0, filesRemoved: 0 };

/** A video file found on disk that no DB row tracks. For series, `episodeIds` is set when the
 *  file matched episodes (approved to import), `rejections` when it didn't (shown instead of an
 *  import checkbox), and `supersedes` lists the existing tracked files it would replace (an
 *  upgrade) — all derived by the server, never taken from a client. Movies have no matching
 *  step, so only `quality` is set. */
export interface ScanUntrackedFile {
  path: string;
  relativePath: string;
  size: number;
  quality: Quality;
  episodeIds?: string[];
  rejections?: ImportRejection[];
  supersedes?: { mediaFileId: string; relativePath: string }[];
}

/** The pure "what differs between disk and DB" computation powering both the silent scheduled
 *  scan and the interactive Manage Files/Episodes screen (FILEMGMT-2). */
export interface ScanPreview {
  stale: { mediaFileId: string; relativePath: string }[];
  untracked: ScanUntrackedFile[];
}

const EMPTY_PREVIEW: ScanPreview = { stale: [], untracked: [] };

/** An existing tracked row, as `existingFiles` returns it — the pieces the compute needs. */
interface ExistingFile {
  id: string;
  relativePath: string;
  episodeIds: string[];
  quality: Quality;
}

/** One file to insert during a scan/apply. `mediaFileId` is pre-assigned at plan-build time so
 *  the same id feeds the insert, the episode `media_file_id` FK wiring and the `supersedes`
 *  removal list. */
interface PlannedImport {
  mediaFileId: string;
  relativePath: string;
  size: number;
  quality: Quality;
  episodeIds: string[];
}

/** Per-season write plan. `episodeUpdates` mirrors `seasonEpisodes` order; `mediaFileId` is
 *  omitted (undefined) when the episode's file must be left to the FK (auto path) and set when
 *  it must be (re)pointed explicitly (interactive path). */
interface SeasonPlan {
  removeIds: string[];
  imports: PlannedImport[];
  episodeUpdates: {
    episodeId: string;
    hasFile: boolean;
    mediaFileId: string | undefined;
  }[];
}

/**
 * Disk scan (roadmap P0.6, gap report B3): before this, the app only knew about files it
 * imported itself. Point it at an existing library — including one brought across by the
 * upstream DB importer (`apps/api/src/upstream-import/upstream/`), which copies series/episode/movie
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
 * FILEMGMT-2 (gap C7 follow-up): computation is split from application. The shared `preview*`
 * methods compute a plain `ScanPreview` (what differs between disk and DB); the existing
 * `scanMovie`/`scanSeries` are rebuilt on top of it — compute the preview, build the changing
 * plan, apply it, observable behavior identical — and the interactive `apply*` methods reuse the
 * same compute + the same single write implementation, applying only the user-selected subset.
 * No scan/match logic is duplicated. Series scanning reuses `decideImportFile()` (P0.5) exactly
 * as import does.
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

  // ------------------------------------------------------------------
  // AUTOMATIC SCAN — behavior identical to pre-refactor; now expressed as
  // `compute preview -> build the full plan -> the single shared write`.
  // ------------------------------------------------------------------

  async scanMovie(movieId: string): Promise<ScanResult> {
    const movie = await this.getMovie(movieId);
    if (!movie?.rootFolderPath) return EMPTY_RESULT;
    const { survivingCount, stale, untracked, filesFound } = await this.computeMovie(movie);

    const filesRemoved = stale.length;
    // Scan reconciles; it doesn't proactively reorganize. If a valid tracked file already
    // exists, an untracked sibling (a leftover extra, a sample) is left alone rather than
    // guessed at — grabbing an upgrade is a decision-engine (P0.3) job, not a scan job.
    const importSingle = survivingCount === 0 && untracked.length > 0;
    const imports: PlannedImport[] = importSingle
      ? [{ mediaFileId: newEntityId("mf"), relativePath: untracked[0].relativePath, size: untracked[0].size, quality: untracked[0].quality, episodeIds: [] }]
      : [];
    const filesAdded = imports.length;
    const hasFile = survivingCount > 0 || filesAdded > 0;
    const now = new Date().toISOString();

    await this.writeMovie(movie, { removeIds: stale.map((s) => s.id), imports }, hasFile, now);
    return { filesFound, filesAdded, filesRemoved };
  }

  async scanSeries(seriesId: string): Promise<ScanResult> {
    const series = await this.getSeries(seriesId);
    if (!series?.rootFolderPath) return EMPTY_RESULT;

    const seasons = await this.db.select().from(schema.season).where(eq(schema.season.seriesId, seriesId));
    const profile = await getQualityProfile(this.db, series.qualityProfileId);
    let filesFound = 0, filesAdded = 0, filesRemoved = 0;

    for (const season of seasons) {
      const compute = await this.computeSeriesSeason(series, season.seasonNumber, profile);
      if (compute.seasonEpisodes.length === 0) continue;
      filesFound += compute.filesFound;
      filesAdded += compute.approved.length;
      filesRemoved += compute.stale.length; // superseded-old removals are not counted (as before)

      const plan = this.buildSeriesAutoPlan(compute);
      await this.writeSeriesSeason(series.id, compute.seasonEpisodes, plan);
    }

    if (filesAdded > 0 || filesRemoved > 0) {
      await this.updateAvailability(seriesId, "series", new Date().toISOString());
    }
    return { filesFound, filesAdded, filesRemoved };
  }

  // ------------------------------------------------------------------
  // INTERACTIVE Manage Files/Episodes (FILEMGMT-2): read-only preview,
  // then apply ONLY the user-selected subset. Nothing is recomputed from
  // client input — selection is a list of relative paths; everything else
  // (quality, episodeIds, supersedes) is re-derived server-side.
  // ------------------------------------------------------------------

  async previewMovie(movieId: string): Promise<ScanPreview> {
    const movie = await this.getMovie(movieId);
    if (!movie?.rootFolderPath) return EMPTY_PREVIEW;
    const { stale, untracked } = await this.computeMovie(movie);
    return {
      stale: stale.map((s) => ({ mediaFileId: s.id, relativePath: s.relativePath })),
      untracked,
    };
  }

  async previewSeries(seriesId: string, seasonNumber?: number): Promise<ScanPreview> {
    const series = await this.getSeries(seriesId);
    if (!series?.rootFolderPath) return EMPTY_PREVIEW;
    const profile = await getQualityProfile(this.db, series.qualityProfileId);
    const seasons = (await this.db.select().from(schema.season).where(eq(schema.season.seriesId, seriesId)))
      .filter((s) => seasonNumber === undefined || s.seasonNumber === seasonNumber);

    const stale: { mediaFileId: string; relativePath: string }[] = [];
    const untracked: ScanUntrackedFile[] = [];
    for (const season of seasons) {
      const compute = await this.computeSeriesSeason(series, season.seasonNumber, profile);
      if (compute.seasonEpisodes.length === 0) continue;
      for (const s of compute.stale) stale.push({ mediaFileId: s.id, relativePath: s.relativePath });
      untracked.push(...compute.untracked);
    }
    return { stale, untracked };
  }

  async applyMovie(movieId: string, opts: { removeStale: string[]; importUntracked: string[] }): Promise<ScanResult> {
    const movie = await this.getMovie(movieId);
    if (!movie?.rootFolderPath) return EMPTY_RESULT;
    const { survivingCount, stale, untracked } = await this.computeMovie(movie);

    const selectedStale = new Set(opts.removeStale);
    const selectedImports = new Set(opts.importUntracked);
    const removeIds = stale.filter((s) => selectedStale.has(s.id)).map((s) => s.id);
    const imports: PlannedImport[] = untracked
      .filter((u) => selectedImports.has(u.relativePath))
      .map((u) => ({ mediaFileId: newEntityId("mf"), relativePath: u.relativePath, size: u.size, quality: u.quality, episodeIds: [] }));
    if (removeIds.length === 0 && imports.length === 0) return EMPTY_RESULT;

    const hasFile = survivingCount - removeIds.length + imports.length > 0;
    await this.writeMovie(movie, { removeIds, imports }, hasFile, new Date().toISOString());
    return { filesFound: untracked.length, filesAdded: imports.length, filesRemoved: removeIds.length };
  }

  async applySeries(
    seriesId: string,
    opts: { removeStale: string[]; importUntracked: string[] },
    seasonNumber?: number,
  ): Promise<ScanResult> {
    const series = await this.getSeries(seriesId);
    if (!series?.rootFolderPath) return EMPTY_RESULT;
    const profile = await getQualityProfile(this.db, series.qualityProfileId);
    const seasons = (await this.db.select().from(schema.season).where(eq(schema.season.seriesId, seriesId)))
      .filter((s) => seasonNumber === undefined || s.seasonNumber === seasonNumber);

    const selectedStale = new Set(opts.removeStale);
    const selectedImports = new Set(opts.importUntracked);
    let filesAdded = 0, filesRemoved = 0, untrackedTotal = 0;

    for (const season of seasons) {
      const compute = await this.computeSeriesSeason(series, season.seasonNumber, profile);
      if (compute.seasonEpisodes.length === 0) continue;
      untrackedTotal += compute.untracked.length;

      // Only approved (matched) files are importable; selection is by relative path, everything
      // else re-derived here. `supersedes` is recomputed from THIS selection only — a superseded
      // file is removed solely as a consequence of the user ticking the file that replaces it
      // (never automatically for a merely-approved-but-unselected candidate), and `removeStale`
      // removes only the explicitly-checked stale rows.
      const chosenImports = compute.untracked.filter((u) => selectedImports.has(u.relativePath) && (u.episodeIds?.length ?? 0) > 0);
      // `supersedes` is computed over `surviving`, so the files it names are always surviving rows
      // (a superseded file is one still on disk — never one already counted as stale).
      const supersededIds = new Set(chosenImports.flatMap((u) => (u.supersedes ?? []).map((s) => s.mediaFileId)));
      const removeIds = new Set<string>([
        ...compute.stale.filter((s) => selectedStale.has(s.id)).map((s) => s.id),
        ...compute.surviving.filter((f) => supersededIds.has(f.id)).map((f) => f.id),
      ]);
      if (chosenImports.length === 0 && removeIds.size === 0) continue;

      const imports: PlannedImport[] = chosenImports.map((u) => ({
        mediaFileId: newEntityId("mf"), relativePath: u.relativePath, size: u.size, quality: u.quality, episodeIds: u.episodeIds!,
      }));
      filesAdded += imports.length;
      filesRemoved += removeIds.size;

      const plan = this.buildSeriesInteractivePlan(compute, [...removeIds], imports);
      await this.writeSeriesSeason(series.id, compute.seasonEpisodes, plan);
    }

    if (filesAdded > 0 || filesRemoved > 0) {
      await this.updateAvailability(seriesId, "series", new Date().toISOString());
    }
    return { filesFound: untrackedTotal, filesAdded, filesRemoved };
  }

  // ------------------------------------------------------------------
  // Compute (pure) — shared by the auto scan and the interactive apply.
  // ------------------------------------------------------------------

  private async computeMovie(movie: typeof schema.movie.$inferSelect) {
    const existing = await this.media.existingFiles(movieTarget(movie.id));
    const surviving: ExistingFile[] = [];
    const stale: ExistingFile[] = [];
    for (const f of existing) (existsSync(join(movie.rootFolderPath!, f.relativePath)) ? surviving : stale).push(f);

    const folder = join(movie.rootFolderPath!, resolvedMovieFolderName(movie));
    const files = await findAllVideos(this.storage, folder);
    const trackedPaths = new Set(surviving.map((f) => join(movie.rootFolderPath!, f.relativePath)));
    const untracked: ScanUntrackedFile[] = files
      .filter((f) => !trackedPaths.has(f.path))
      .map((f) => ({
        path: f.path,
        relativePath: relative(movie.rootFolderPath!, f.path),
        size: f.size,
        quality: parseQualityFromTitle(baseNameOf(f.path)),
      }));

    return { surviving, stale, untracked, filesFound: files.length, survivingCount: surviving.length };
  }

  /** Per-season series compute — mirrors scanSeries's pre-refactor loop body, split out so it
   *  feeds both the auto scan and the interactive preview/apply. */
  private async computeSeriesSeason(
    series: typeof schema.series.$inferSelect,
    seasonNumber: number,
    profile: Awaited<ReturnType<typeof getQualityProfile>>,
  ) {
    const seasonEpisodes = await this.media.episodesInSeason(series.id, seasonNumber);
    const root = series.rootFolderPath!;
    const existing = await this.media.existingFiles(episodeTarget(series.id, seasonNumber, seasonEpisodes, true));
    const surviving: ExistingFile[] = [];
    const stale: ExistingFile[] = [];
    for (const f of existing) (existsSync(join(root, f.relativePath)) ? surviving : stale).push(f);

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

    const seasonDir = join(root, resolvedSeriesFolderName(series), `Season ${seasonNumber}`);
    const files = await findAllVideos(this.storage, seasonDir);
    const trackedPaths = new Set(surviving.map((f) => join(root, f.relativePath)));
    const untrackedFiles = files.filter((f) => !trackedPaths.has(f.path));

    const untracked: ScanUntrackedFile[] = [];
    const approved: ScanUntrackedFile[] = [];
    for (const file of untrackedFiles) {
      const fname = baseNameOf(file.path);
      const match = parseEpisodeRelease(fname);
      let episodesInFile = match.episodes;
      // Daily/anime files name a date or absolute number instead of S&E (episodes stay
      // empty in the pure parse). Resolve them against the series' own numbering and
      // keep only episodes belonging to the season dir currently being scanned.
      if (series.seriesType !== "standard" && episodesInFile.length === 0
        && (match.dailyDate !== undefined || match.absoluteNumber !== undefined)) {
        const resolved = await this.media.resolveEpisodeTargets(series.seriesType as SeriesType, series.id, match);
        episodesInFile = (resolved?.episodes ?? [])
          .filter((e) => e.seasonNumber === seasonNumber)
          .map((e) => e.episodeNumber);
      }
      const quality = parseQualityFromTitle(fname);
      const decision = decideImportFile(file, episodesInFile, knownEpisodes, quality, profile);
      const entry: ScanUntrackedFile = { path: file.path, relativePath: relative(root, file.path), size: file.size, quality };
      if (decision.approved && decision.episodeIds.length > 0) {
        entry.episodeIds = decision.episodeIds;
        // This file fully replaces an existing tracked file when it covers every episode that
        // file covers (the same "fully superseded" rule the auto scan uses once applied).
        entry.supersedes = surviving
          .filter((f) => f.episodeIds.length > 0 && f.episodeIds.every((id) => entry.episodeIds!.includes(id)))
          .map((f) => ({ mediaFileId: f.id, relativePath: f.relativePath }));
        approved.push(entry);
      } else {
        entry.rejections = decision.rejections;
      }
      untracked.push(entry);
    }

    // The auto-scan's season-wide "every covered episode has a replacement" supersession set.
    const newlyCovered = new Set(approved.flatMap((a) => a.episodeIds!));
    const supersededOld = surviving.filter((f) => f.episodeIds.length > 0 && f.episodeIds.every((id) => newlyCovered.has(id)));

    return { seasonNumber, seasonEpisodes, surviving, stale, untracked, approved, supersededOld, filesFound: files.length };
  }

  // ------------------------------------------------------------------
  // Plan building — the only place where auto vs interactive differ.
  // ------------------------------------------------------------------

  /** The auto scan's per-season plan: remove every stale + every fully-superseded row, import
   *  every approved file, set each episode's hasFile from the covered set and point newly-covered
   *  episodes at their new file — the exact semantics of the pre-refactor scanSeries transaction. */
  private buildSeriesAutoPlan(compute: Awaited<ReturnType<LibraryScanService["computeSeriesSeason"]>>): SeasonPlan {
    const imports: PlannedImport[] = compute.approved.map((a) => ({
      mediaFileId: newEntityId("mf"), relativePath: a.relativePath, size: a.size, quality: a.quality, episodeIds: a.episodeIds!,
    }));
    const episodeToNewFile = new Map<string, string>();
    for (const im of imports) for (const epId of im.episodeIds) episodeToNewFile.set(epId, im.mediaFileId);

    const coveredEpisodeIds = new Set<string>();
    for (const im of imports) for (const epId of im.episodeIds) coveredEpisodeIds.add(epId);
    const supersededIds = new Set(compute.supersededOld.map((f) => f.id));
    for (const f of compute.surviving) {
      if (supersededIds.has(f.id)) continue;
      for (const id of f.episodeIds) coveredEpisodeIds.add(id);
    }

    const removeIds = [...compute.stale.map((f) => f.id), ...compute.supersededOld.map((f) => f.id)];
    const episodeUpdates = compute.seasonEpisodes.map((ep) => ({
      episodeId: ep.id,
      hasFile: coveredEpisodeIds.has(ep.id),
      mediaFileId: episodeToNewFile.get(ep.id),
    }));
    return { removeIds, imports, episodeUpdates };
  }

  /** The interactive per-season plan: import only the chosen files, remove only the chosen stale
   *  rows plus the explicit supersessions of the chosen imports (never automatic), and recompute
   *  every episode's hasFile/mediaFileId from the real post-apply covering set — NOT from the
   *  auto-scan's assumption that everything approved was applied. */
  private buildSeriesInteractivePlan(
    compute: Awaited<ReturnType<LibraryScanService["computeSeriesSeason"]>>,
    removeIds: string[],
    imports: PlannedImport[],
  ): SeasonPlan {
    const removeSet = new Set(removeIds);
    const imported = imports.map((i) => ({ id: i.mediaFileId, episodeIds: i.episodeIds }));
    const covering = [...compute.surviving.filter((f) => !removeSet.has(f.id)), ...imported];
    const byEpisode = new Map<string, string>();
    for (const f of covering) for (const epId of f.episodeIds) {
      if (!byEpisode.has(epId)) byEpisode.set(epId, f.id);
    }
    const episodeUpdates = compute.seasonEpisodes.map((ep) => ({
      episodeId: ep.id,
      hasFile: byEpisode.has(ep.id),
      mediaFileId: byEpisode.get(ep.id),
    }));
    return { removeIds, imports, episodeUpdates };
  }

  // ------------------------------------------------------------------
  // SHARED WRITE — the ONE implementation both the auto scan and the
  // interactive apply go through per media type (dialect-branched; never
  // call `.run()` on a possibly-Postgres query).
  // ------------------------------------------------------------------

  private async writeMovie(
    movie: typeof schema.movie.$inferSelect,
    plan: { removeIds: string[]; imports: PlannedImport[] },
    hasFile: boolean,
    now: string,
  ): Promise<void> {
    const changed = plan.removeIds.length > 0 || plan.imports.length > 0;
    if (this.db.dbDialect === "postgres") {
      await this.db.transaction(async (tx) => {
        for (const id of plan.removeIds) await tx.delete(schema.mediaFile).where(eq(schema.mediaFile.id, id));
        for (const im of plan.imports) {
          await tx.insert(schema.mediaFile).values({
            id: im.mediaFileId, mediaType: "movie", mediaId: movie.id,
            relativePath: im.relativePath, size: im.size, quality: im.quality, dateAdded: now,
          });
        }
        if (hasFile !== movie.hasFile) {
          await tx.update(schema.movie).set({ hasFile, updatedAt: now }).where(eq(schema.movie.id, movie.id));
        }
        if (changed) await this.markAvailability(tx, "movie", movie.id, now);
      });
    } else {
      this.db.transaction((tx) => {
        for (const id of plan.removeIds) tx.delete(schema.mediaFile).where(eq(schema.mediaFile.id, id)).run();
        for (const im of plan.imports) {
          tx.insert(schema.mediaFile).values({
            id: im.mediaFileId, mediaType: "movie", mediaId: movie.id,
            relativePath: im.relativePath, size: im.size, quality: im.quality, dateAdded: now,
          }).run();
        }
        if (hasFile !== movie.hasFile) {
          tx.update(schema.movie).set({ hasFile, updatedAt: now }).where(eq(schema.movie.id, movie.id)).run();
        }
        if (changed) this.markAvailabilitySync(tx, "movie", movie.id, now);
      });
    }
  }

  /** One transaction per season, matching the granularity the reconciliation loop already treats
   *  each season at: a failure writing a later season must not roll back an earlier season's
   *  already-applied changes. */
  private async writeSeriesSeason(seriesId: string, seasonEpisodes: { id: string; hasFile: boolean }[], plan: SeasonPlan): Promise<void> {
    if (this.db.dbDialect === "postgres") {
      // better-sqlite3's native tx wrapper needs a sync callback; node-postgres needs async
      // (P2 item 12 Stage 2) — two irreconcilable signatures, so Postgres gets its own body.
      await this.db.transaction(async (tx) => {
        for (const id of plan.removeIds) await tx.delete(schema.mediaFile).where(eq(schema.mediaFile.id, id));
        for (const im of plan.imports) {
          await tx.insert(schema.mediaFile).values({
            id: im.mediaFileId, mediaType: "series", mediaId: seriesId,
            relativePath: im.relativePath, size: im.size, quality: im.quality, dateAdded: new Date().toISOString(),
          });
        }
        // J3: point newly/re-pointed episodes at their file via media_file_id — the single
        // source of coverage truth now (the episode_ids JSON column is gone).
        for (let i = 0; i < plan.episodeUpdates.length; i++) {
          const up = plan.episodeUpdates[i];
          const current = seasonEpisodes[i];
          const set: { hasFile?: boolean; mediaFileId?: string } = {};
          if (up.hasFile !== current.hasFile) set.hasFile = up.hasFile;
          if (up.mediaFileId !== undefined) set.mediaFileId = up.mediaFileId;
          if (Object.keys(set).length > 0) {
            await tx.update(schema.episode).set(set).where(eq(schema.episode.id, up.episodeId));
          }
        }
      });
    } else {
      this.db.transaction((tx) => {
        for (const id of plan.removeIds) tx.delete(schema.mediaFile).where(eq(schema.mediaFile.id, id)).run();
        for (const im of plan.imports) {
          tx.insert(schema.mediaFile).values({
            id: im.mediaFileId, mediaType: "series", mediaId: seriesId,
            relativePath: im.relativePath, size: im.size, quality: im.quality, dateAdded: new Date().toISOString(),
          }).run();
        }
        // J3 (sync body — SQLite path): same episode->file FK wiring as the pg body.
        for (let i = 0; i < plan.episodeUpdates.length; i++) {
          const up = plan.episodeUpdates[i];
          const current = seasonEpisodes[i];
          const set: { hasFile?: boolean; mediaFileId?: string } = {};
          if (up.hasFile !== current.hasFile) set.hasFile = up.hasFile;
          if (up.mediaFileId !== undefined) set.mediaFileId = up.mediaFileId;
          if (Object.keys(set).length > 0) {
            tx.update(schema.episode).set(set).where(eq(schema.episode.id, up.episodeId)).run();
          }
        }
      });
    }
  }

  // ------------------------------------------------------------------
  // Small shared helpers.
  // ------------------------------------------------------------------

  private async getMovie(movieId: string) {
    const rows = await this.db.select().from(schema.movie).where(eq(schema.movie.id, movieId)).limit(1);
    return rows[0];
  }

  private async getSeries(seriesId: string) {
    const rows = await this.db.select().from(schema.series).where(eq(schema.series.id, seriesId)).limit(1);
    return rows[0];
  }

  private async updateAvailability(mediaId: string, mediaType: MediaType, now: string): Promise<void> {
    if (this.db.dbDialect === "postgres") {
      await this.db.transaction(async (tx) => this.markAvailability(tx, mediaType, mediaId, now));
    } else {
      this.db.transaction((tx) => this.markAvailabilitySync(tx, mediaType, mediaId, now));
    }
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

  /** Async counterpart of `markAvailabilitySync`, for use inside a Postgres transaction
   *  callback (roadmap P2 item 12 Stage 2 — Postgres transaction bodies are async). */
  private async markAvailability(tx: Tx, mediaType: MediaType, mediaId: string, now: string): Promise<void> {
    const status = mediaType === "movie" ? "available" : await this.seriesAvailability(tx, mediaId);
    await ensureAvailabilityTx(tx, mediaType, mediaId);
    await tx.update(schema.mediaAvailability)
      .set({ status, lastAvailabilitySyncAt: now })
      .where(and(eq(schema.mediaAvailability.mediaType, mediaType), eq(schema.mediaAvailability.mediaId, mediaId)));
  }

  private async seriesAvailability(tx: Tx, seriesId: string): Promise<"available" | "partially_available"> {
    const eps = await tx.select({ hasFile: schema.episode.hasFile, monitored: schema.episode.monitored })
      .from(schema.episode).where(eq(schema.episode.seriesId, seriesId));
    const missing = eps.some((e) => e.monitored && !e.hasFile);
    return missing ? "partially_available" : "available";
  }
}

function baseNameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
