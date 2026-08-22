// SPDX-License-Identifier: MIT
import { Inject, Injectable, Logger, OnModuleInit, Optional } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { join, relative } from "node:path";
import { existsSync } from "node:fs";
import { newEntityId } from "@medianexus/shared";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import {
  movieTarget, episodeTarget, parseQualityFromTitle, parseEpisodeRelease, compareQuality,
  decideImportFile, meetsCutoff, qualityId, qualityMeta,
  type MediaType, type Quality, type KnownEpisode, type SeriesType, type ImportRejection,
  type ReleaseTypeValue,
} from "@medianexus/domain";
import { LocalStorageProvider, findAllVideos } from "@medianexus/integrations";
import { MediaRepository } from "../media/media.repository";
import { RecycleBinService } from "../media/recycle-bin.service";
import { ensureAvailabilitySync, ensureAvailabilityTx, getQualityProfile, attachMatchedFormats, type Tx } from "../media/library.helpers";
import { resolvedMovieFolderName, resolvedSeriesFolderName } from "../media/naming.helpers";
import { selectMediaFiles, type MediaFileRow } from "../media/media-file.types";
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
  /** The merged tracked+untracked table (MANAGEFILES-1) — the single row source for the rebuilt
   *  Manage Files/Episodes modal. Kept alongside `stale`/`untracked` so the older consumers and
   *  the scheduled-scan path keep working; the modal reads only `items`. */
  items: ManageFileRow[];
}

/** One episode reference shown in a merged Manage Files row (series only). */
export interface ManageEpisodeRef {
  id: string;
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  airDateUtc: string | null;
}

/** One row of the merged Manage Files/Episodes table (MANAGEFILES-1) — the real folder rescan
 *  combining tracked DB rows (surviving + stale) with on-disk untracked files, mirroring
 *  upstream's InteractiveImportModal. `mediaFileId` marks a tracked row; `stale` marks a tracked
 *  row whose file has vanished (deletable, not editable). Untracked rows carry neither. */
export interface ManageFileRow {
  mediaFileId?: string;
  stale?: boolean;
  relativePath: string;
  size: number;
  quality: Quality | null;
  /** Series only. */
  seasonNumber?: number;
  /** Series only — episodes the row currently covers (tracked) or matched (untracked). */
  episodes?: ManageEpisodeRef[];
  releaseGroup: string | null;
  languages: string[];
  /** Series only. Set for tracked rows (persisted column or derived) and matched untracked rows;
   *  null for movies and unmatched series files. */
  releaseType: ReleaseTypeValue | null;
  matchedFormats: { id: string; name: string }[];
  indexerFlags: number;
  /** Quality-cutoff rejection for tracked rows below the title's profile cutoff; for untracked
   *  series rows the import-decision rejections. Movies always importable -> [] until imported. */
  rejections: ImportRejection[];
}

/** A per-row edit on an already-tracked file, applied by POST :id/manage-files/apply. */
export interface ManageFileUpdate {
  mediaFileId: string;
  quality?: Quality;
  languages?: string[];
  releaseGroup?: string | null;
  releaseType?: ReleaseTypeValue | null;
  indexerFlags?: number;
  /** Series only: reassign the file to cover exactly these episode ids (absent = unchanged). */
  episodes?: string[];
}

/** The interactive apply's full request surface (FILEMGMT-2 + MANAGEFILES-1). `removeStale` and
 *  `importUntracked` are the pre-existing selection; `deleteFiles`/`deleteUntracked`/`updates`
 *  are the MANAGEFILES-1 additions. */
export interface ManageApplyOptions {
  removeStale: string[];
  importUntracked: string[];
  /** Tracked media_file ids to delete: physical file disposed (recycle bin) + row removed. */
  deleteFiles?: string[];
  /** Untracked on-disk relativePaths to delete: physical file disposed only (no row). */
  deleteUntracked?: string[];
  /** Per-row edits on tracked files. */
  updates?: ManageFileUpdate[];
}

const EMPTY_PREVIEW: ScanPreview = { stale: [], untracked: [], items: [] };

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
 *  undefined when the episode's file must be left alone (auto path), null when it must be
 *  cleared (a removed/repointed file), and set when it must be (re)pointed explicitly.
 *  `updates` are column patches applied to this season's surviving tracked files (MANAGEFILES-1). */
interface SeasonPlan {
  removeIds: string[];
  imports: PlannedImport[];
  episodeUpdates: {
    episodeId: string;
    hasFile: boolean;
    mediaFileId: string | null | undefined;
  }[];
  updates?: { mediaFileId: string; patch: Partial<typeof schema.mediaFile.$inferInsert> }[];
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
    @Optional() private readonly recycleBin?: RecycleBinService,
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
    const { stale, untracked, surviving } = await this.computeMovie(movie);
    const profile = await getQualityProfile(this.db, movie.qualityProfileId);
    const tracked = await selectMediaFiles(this.db, "movie", movieId);
    const trackedById = new Map(tracked.map((f) => [f.id, f]));

    const items: ManageFileRow[] = [];
    const slotByPath = new Map<string, ManageFileRow>();
    const formatRows: MediaFileRow[] = [...tracked];
    for (const s of surviving) {
      const item = this.trackedManageRow(s.id, trackedById.get(s.id), false, profile, "movie");
      items.push(item); slotByPath.set(item.relativePath, item);
    }
    for (const s of stale) {
      const item = this.trackedManageRow(s.id, trackedById.get(s.id), true, profile, "movie");
      items.push(item); slotByPath.set(item.relativePath, item);
    }
    for (const u of untracked) {
      const item: ManageFileRow = {
        relativePath: u.relativePath, size: u.size, quality: u.quality, releaseGroup: null,
        languages: [], releaseType: null, matchedFormats: [], indexerFlags: 0, rejections: [],
      };
      items.push(item); slotByPath.set(item.relativePath, item);
      formatRows.push(this.pseudoFormatRow(`untracked:${u.relativePath}`, u.relativePath, u.size, u.quality));
    }
    // matchedFormats for every row (tracked + untracked) in one pass through the shared helper.
    await attachMatchedFormats(this.db, formatRows);
    for (const f of formatRows) {
      const item = slotByPath.get(f.relativePath);
      if (item) item.matchedFormats = f.matchedFormats;
    }

    return {
      stale: stale.map((s) => ({ mediaFileId: s.id, relativePath: s.relativePath })),
      untracked,
      items,
    };
  }

  async previewSeries(seriesId: string, seasonNumber?: number): Promise<ScanPreview> {
    const series = await this.getSeries(seriesId);
    if (!series?.rootFolderPath) return EMPTY_PREVIEW;
    const profile = await getQualityProfile(this.db, series.qualityProfileId);
    const seasons = (await this.db.select().from(schema.season).where(eq(schema.season.seriesId, seriesId)))
      .filter((s) => seasonNumber === undefined || s.seasonNumber === seasonNumber);

    const allFiles = await selectMediaFiles(this.db, "series", seriesId);
    const trackedById = new Map(allFiles.map((f) => [f.id, f]));
    const allEpisodes = await this.db
      .select({
        id: schema.episode.id,
        seasonNumber: schema.season.seasonNumber,
        episodeNumber: schema.episode.episodeNumber,
        title: schema.episode.title,
        airDateUtc: schema.episode.airDateUtc,
      })
      .from(schema.episode)
      .innerJoin(schema.season, eq(schema.episode.seasonId, schema.season.id))
      .where(eq(schema.episode.seriesId, seriesId));
    const episodeById = new Map(allEpisodes.map((e) => [e.id, e]));

    const stale: { mediaFileId: string; relativePath: string }[] = [];
    const untracked: ScanUntrackedFile[] = [];
    const items: ManageFileRow[] = [];
    const slotByPath = new Map<string, ManageFileRow>();
    const formatRows: MediaFileRow[] = [...allFiles];

    for (const season of seasons) {
      const compute = await this.computeSeriesSeason(series, season.seasonNumber, profile);
      if (compute.seasonEpisodes.length === 0) continue;
      for (const s of compute.stale) stale.push({ mediaFileId: s.id, relativePath: s.relativePath });
      untracked.push(...compute.untracked);

      const epRefs = (ids: string[]): ManageEpisodeRef[] =>
        ids.map((id) => episodeById.get(id)).filter((e): e is ManageEpisodeRef => e !== undefined);
      const seasonEpCount = compute.seasonEpisodes.length;

      for (const s of compute.surviving) {
        const row = trackedById.get(s.id);
        const episodes = epRefs(row?.episodeIds ?? []);
        const item = this.trackedManageRow(s.id, row, false, profile, "series", episodes, episodes[0]?.seasonNumber, seasonEpCount);
        items.push(item); slotByPath.set(item.relativePath, item);
      }
      for (const s of compute.stale) {
        const row = trackedById.get(s.id);
        const episodes = epRefs(row?.episodeIds ?? []);
        const item = this.trackedManageRow(s.id, row, true, profile, "series", episodes, episodes[0]?.seasonNumber, seasonEpCount);
        items.push(item); slotByPath.set(item.relativePath, item);
      }
      for (const u of compute.untracked) {
        const matched = (u.episodeIds ?? []).map((id) => episodeById.get(id)).filter((e): e is ManageEpisodeRef => e !== undefined);
        const releaseType: ReleaseTypeValue | null =
          matched.length === 0 ? null
            : matched.length >= seasonEpCount ? "season"
              : matched.length > 1 ? "multi" : "single";
        const item: ManageFileRow = {
          relativePath: u.relativePath, size: u.size, quality: u.quality, releaseGroup: null,
          languages: [], releaseType, matchedFormats: [], indexerFlags: 0,
          seasonNumber: matched[0]?.seasonNumber,
          episodes: matched.length > 0 ? matched : undefined,
          rejections: u.rejections ?? [],
        };
        items.push(item); slotByPath.set(item.relativePath, item);
        formatRows.push(this.pseudoFormatRow(`untracked:${u.relativePath}`, u.relativePath, u.size, u.quality));
      }
    }

    await attachMatchedFormats(this.db, formatRows);
    for (const f of formatRows) {
      const item = slotByPath.get(f.relativePath);
      if (item) item.matchedFormats = f.matchedFormats;
    }

    return { stale, untracked, items };
  }

  async applyMovie(movieId: string, opts: ManageApplyOptions): Promise<ScanResult> {
    const movie = await this.getMovie(movieId);
    if (!movie?.rootFolderPath) return EMPTY_RESULT;
    const { survivingCount, surviving, stale, untracked } = await this.computeMovie(movie);

    const selectedStale = new Set(opts.removeStale);
    const selectedImports = new Set(opts.importUntracked);
    const deleteIds = new Set(opts.deleteFiles ?? []);
    const deleteUntracked = new Set(opts.deleteUntracked ?? []);
    const deleteUntrackedList = untracked.filter((u) => deleteUntracked.has(u.relativePath));

    const removeIds = new Set<string>([
      ...stale.filter((s) => selectedStale.has(s.id) || deleteIds.has(s.id)).map((s) => s.id),
      ...surviving.filter((f) => deleteIds.has(f.id)).map((f) => f.id),
    ]);
    const imports: PlannedImport[] = untracked
      .filter((u) => selectedImports.has(u.relativePath) && !deleteUntracked.has(u.relativePath))
      .map((u) => ({ mediaFileId: newEntityId("mf"), relativePath: u.relativePath, size: u.size, quality: u.quality, episodeIds: [] }));
    // An update on a row that is simultaneously being deleted is a no-op (delete wins).
    const updates = (opts.updates ?? [])
      .filter((u) => !deleteIds.has(u.mediaFileId) && !selectedStale.has(u.mediaFileId))
      .map((u) => ({ mediaFileId: u.mediaFileId, patch: this.columnPatch(u) }));

    const changed = removeIds.size > 0 || imports.length > 0 || updates.length > 0 || deleteUntrackedList.length > 0;
    if (!changed) return EMPTY_RESULT;

    // Dispose physical files for explicit deletes OUTSIDE any transaction (fs ops; a missing
    // source must not block — same wrapper MediaFilesService.remove uses).
    const survivingById = new Map(surviving.map((f) => [f.id, f]));
    for (const id of deleteIds) {
      const f = survivingById.get(id);
      if (f) await this.disposePhysical(join(movie.rootFolderPath!, f.relativePath));
    }
    for (const u of deleteUntrackedList) await this.disposePhysical(u.path);

    const hasFile = survivingCount - removeIds.size + imports.length > 0;
    await this.writeMovie(movie, { removeIds: [...removeIds], imports, updates }, hasFile, new Date().toISOString());
    return { filesFound: untracked.length, filesAdded: imports.length, filesRemoved: removeIds.size + deleteUntrackedList.length };
  }

  async applySeries(
    seriesId: string,
    opts: ManageApplyOptions,
    seasonNumber?: number,
  ): Promise<ScanResult> {
    const series = await this.getSeries(seriesId);
    if (!series?.rootFolderPath) return EMPTY_RESULT;
    const profile = await getQualityProfile(this.db, series.qualityProfileId);
    const seasons = (await this.db.select().from(schema.season).where(eq(schema.season.seriesId, seriesId)))
      .filter((s) => seasonNumber === undefined || s.seasonNumber === seasonNumber);

    const selectedStale = new Set(opts.removeStale);
    const selectedImports = new Set(opts.importUntracked);
    const deleteIds = new Set(opts.deleteFiles ?? []);
    const deleteUntracked = new Set(opts.deleteUntracked ?? []);
    const updatesById = new Map((opts.updates ?? []).map((u) => [u.mediaFileId, u]));

    // Tracked-row surface (for delete disposal paths + episode repointing) and the post-apply
    // episode→file map computed ONCE over the whole series so repoints can cross seasons.
    const allEpisodes = await this.db.select().from(schema.episode).where(eq(schema.episode.seriesId, seriesId));
    const finalByEpisode = new Map<string, string>();
    for (const e of allEpisodes) if (e.mediaFileId) finalByEpisode.set(e.id, e.mediaFileId);

    let filesAdded = 0, filesRemoved = 0, untrackedDeleted = 0, untrackedTotal = 0;
    const allRemoveIds = new Set<string>();
    const allImports: PlannedImport[] = [];

    // Pass 1: compute imports/removals/repoints per season + the final coverage map.
    for (const season of seasons) {
      const compute = await this.computeSeriesSeason(series, season.seasonNumber, profile);
      if (compute.seasonEpisodes.length === 0) continue;
      untrackedTotal += compute.untracked.length;

      const chosenImports = compute.untracked.filter((u) => selectedImports.has(u.relativePath) && (u.episodeIds?.length ?? 0) > 0 && !deleteUntracked.has(u.relativePath));
      const supersededIds = new Set(chosenImports.flatMap((u) => (u.supersedes ?? []).map((s) => s.mediaFileId)));
      for (const id of [...compute.stale.filter((s) => selectedStale.has(s.id)).map((s) => s.id),
        ...compute.surviving.filter((f) => supersededIds.has(f.id)).map((f) => f.id)]) allRemoveIds.add(id);

      const imports: PlannedImport[] = chosenImports.map((u) => ({
        mediaFileId: newEntityId("mf"), relativePath: u.relativePath, size: u.size, quality: u.quality, episodeIds: u.episodeIds!,
      }));
      allImports.push(...imports);
      filesAdded += imports.length;

      for (const u of compute.untracked) {
        if (deleteUntracked.has(u.relativePath)) {
          untrackedDeleted += 1;
          await this.disposePhysical(u.path);
        }
      }
      for (const f of compute.surviving) {
        if (deleteIds.has(f.id)) {
          allRemoveIds.add(f.id);
          await this.disposePhysical(join(series.rootFolderPath!, f.relativePath));
        }
      }
      for (const s of compute.stale) {
        if (deleteIds.has(s.id)) allRemoveIds.add(s.id);
      }
    }

    // Post-apply coverage: clear deleted files + repointed files, then add imports.
    for (const id of allRemoveIds) {
      for (const [epId, fid] of [...finalByEpisode]) if (fid === id) finalByEpisode.delete(epId);
    }
    for (const [fileId, up] of updatesById) {
      if (allRemoveIds.has(fileId) || up.episodes === undefined) continue;
      for (const [epId, fid] of [...finalByEpisode]) if (fid === fileId) finalByEpisode.delete(epId);
      for (const epId of up.episodes) finalByEpisode.set(epId, fileId);
    }
    for (const im of allImports) {
      for (const epId of im.episodeIds) finalByEpisode.set(epId, im.mediaFileId);
    }

    // Pass 2: write per season (transaction granularity preserved), applying column patches and
    // the final coverage for each season's episodes. writeSeriesSeason diffs every episode row
    // against its current value, so a season with nothing actually changing is a no-op write.
    for (const season of seasons) {
      const compute = await this.computeSeriesSeason(series, season.seasonNumber, profile);
      if (compute.seasonEpisodes.length === 0) continue;

      const seasonRemove = [...allRemoveIds].filter((id) =>
        compute.surviving.some((f) => f.id === id) || compute.stale.some((s) => s.id === id));
      const seasonImports = allImports.filter((im) =>
        im.episodeIds.some((id) => compute.seasonEpisodes.some((e) => e.id === id)));
      const seasonUpdates = [...updatesById]
        .filter(([id]) => !allRemoveIds.has(id) && (compute.surviving.some((f) => f.id === id) || compute.stale.some((s) => s.id === id)))
        .map(([id, u]) => ({ mediaFileId: id, patch: this.columnPatch(u) }));
      const episodeUpdates = compute.seasonEpisodes.map((ep) => {
        const fileId = finalByEpisode.get(ep.id);
        return { episodeId: ep.id, hasFile: fileId !== undefined, mediaFileId: fileId ?? null };
      });

      filesRemoved += seasonRemove.length;
      await this.writeSeriesSeason(series.id, compute.seasonEpisodes, {
        removeIds: seasonRemove,
        imports: seasonImports,
        episodeUpdates,
        updates: seasonUpdates,
      });
    }

    if (filesAdded > 0 || filesRemoved > 0 || untrackedDeleted > 0) {
      await this.updateAvailability(seriesId, "series", new Date().toISOString());
    }
    return { filesFound: untrackedTotal, filesAdded, filesRemoved: filesRemoved + untrackedDeleted };
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

  /** The interactive apply builds its per-season plan directly in applySeries (MANAGEFILES-1) —
   *  it needs the whole series' final coverage map plus per-row column patches, not the old
   *  single-season covering-set derivation, so that helper was folded into the apply loop. */

  // ------------------------------------------------------------------
  // SHARED WRITE — the ONE implementation both the auto scan and the
  // interactive apply go through per media type (dialect-branched; never
  // call `.run()` on a possibly-Postgres query).
  // ------------------------------------------------------------------

  private async writeMovie(
    movie: typeof schema.movie.$inferSelect,
    plan: { removeIds: string[]; imports: PlannedImport[]; updates?: { mediaFileId: string; patch: Partial<typeof schema.mediaFile.$inferInsert> }[] },
    hasFile: boolean,
    now: string,
  ): Promise<void> {
    const changed = plan.removeIds.length > 0 || plan.imports.length > 0 || (plan.updates?.length ?? 0) > 0;
    if (this.db.dbDialect === "postgres") {
      await this.db.transaction(async (tx) => {
        for (const id of plan.removeIds) await tx.delete(schema.mediaFile).where(eq(schema.mediaFile.id, id));
        for (const im of plan.imports) {
          await tx.insert(schema.mediaFile).values({
            id: im.mediaFileId, mediaType: "movie", mediaId: movie.id,
            relativePath: im.relativePath, size: im.size, quality: im.quality, dateAdded: now,
          });
        }
        for (const up of plan.updates ?? []) {
          if (Object.keys(up.patch).length === 0) continue; // episode-only edit (no column patch)
          await tx.update(schema.mediaFile).set(up.patch).where(eq(schema.mediaFile.id, up.mediaFileId));
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
        for (const up of plan.updates ?? []) {
          if (Object.keys(up.patch).length === 0) continue; // episode-only edit (no column patch)
          tx.update(schema.mediaFile).set(up.patch).where(eq(schema.mediaFile.id, up.mediaFileId)).run();
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
        for (const up of plan.updates ?? []) {
          if (Object.keys(up.patch).length === 0) continue; // episode-only edit (no column patch)
          await tx.update(schema.mediaFile).set(up.patch).where(eq(schema.mediaFile.id, up.mediaFileId));
        }
        // J3: point newly/re-pointed episodes at their file via media_file_id — the single
        // source of coverage truth now (the episode_ids JSON column is gone).
        for (let i = 0; i < plan.episodeUpdates.length; i++) {
          const up = plan.episodeUpdates[i];
          const current = seasonEpisodes[i];
          const set: { hasFile?: boolean; mediaFileId?: string | null } = {};
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
        for (const up of plan.updates ?? []) {
          if (Object.keys(up.patch).length === 0) continue; // episode-only edit (no column patch)
          tx.update(schema.mediaFile).set(up.patch).where(eq(schema.mediaFile.id, up.mediaFileId)).run();
        }
        // J3 (sync body — SQLite path): same episode->file FK wiring as the pg body.
        for (let i = 0; i < plan.episodeUpdates.length; i++) {
          const up = plan.episodeUpdates[i];
          const current = seasonEpisodes[i];
          const set: { hasFile?: boolean; mediaFileId?: string | null } = {};
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

  /** Build a merged-table row for a tracked media_file (surviving or stale). Below-cutoff
   *  rejection uses the same `meetsCutoff()` domain function Cutoff Unmet uses; the message
   *  carries the canonical registry quality title. */
  private trackedManageRow(
    id: string,
    row: MediaFileRow | undefined,
    stale: boolean,
    profile: Awaited<ReturnType<typeof getQualityProfile>>,
    mediaType: "movie" | "series",
    episodes?: ManageEpisodeRef[],
    seasonNumber?: number,
    seasonEpisodeCount?: number,
  ): ManageFileRow {
    const quality = (row?.quality ?? null) as Quality | null;
    let releaseType = row?.releaseType ?? null;
    if (mediaType === "series" && releaseType === null && episodes && episodes.length > 0) {
      releaseType = episodes.length >= (seasonEpisodeCount ?? -1) && episodes.length > 1 ? "season" : episodes.length > 1 ? "multi" : "single";
    }
    const rejections: ImportRejection[] = [];
    if (!stale && quality && profile && !meetsCutoff(profile, quality)) {
      const title = qualityMeta(qualityId(quality))?.title ?? `${quality.source}/${quality.resolution}`;
      rejections.push({ reason: "below_cutoff", message: `Below cutoff (${title})` });
    }
    return {
      mediaFileId: id,
      stale,
      relativePath: row?.relativePath ?? "",
      size: row?.size ?? 0,
      quality,
      seasonNumber,
      episodes,
      releaseGroup: row?.releaseGroup ?? null,
      languages: row?.languages ?? [],
      releaseType,
      matchedFormats: row?.matchedFormats ?? [],
      indexerFlags: row?.indexerFlags ?? 0,
      rejections,
    };
  }

  /** A lightweight MediaFileRow stand-in for an untracked on-disk file, so the shared
   *  `attachMatchedFormats` helper can score it in the same single pass as the tracked rows. */
  private pseudoFormatRow(id: string, relativePath: string, size: number, quality: Quality): MediaFileRow {
    return {
      id, mediaType: "series", mediaId: "", episodeIds: [], relativePath, size, quality,
      mediaInfo: null, languages: [], releaseGroup: null, dateAdded: null,
      indexerFlags: 0, releaseType: null, matchedFormats: [],
    };
  }

  /** Dispose a physical file through the recycle bin (or outright when unconfigured). A
   *  missing source must not block the surrounding apply — same wrapper MediaFilesService.remove
   *  uses, so a stale-looking delete can't half-fail. A real disposal failure is logged, never
   *  silently swallowed (the .catch(() => {}) pattern has caused real bugs in this repo). */
  private async disposePhysical(absolutePath: string): Promise<void> {
    if (!this.recycleBin) {
      try {
        await this.storage.delete(absolutePath);
      } catch (err) {
        this.logger.warn(`Failed to dispose media file ${absolutePath}: ${(err as Error).message}`);
      }
      return;
    }
    try {
      await this.recycleBin.dispose(absolutePath);
    } catch (err) {
      this.logger.warn(`Failed to dispose media file ${absolutePath}: ${(err as Error).message}`);
    }
  }

  /** Reduce a ManageFileUpdate to the plain column patch it implies — episode reassignment is
   *  handled by the coverage-map repoint, never a column write. */
  private columnPatch(u: ManageFileUpdate): Partial<typeof schema.mediaFile.$inferInsert> {
    const patch: Partial<typeof schema.mediaFile.$inferInsert> = {};
    if (u.quality !== undefined) patch.quality = u.quality;
    if (u.languages !== undefined) patch.languages = u.languages;
    if (u.releaseGroup !== undefined) patch.releaseGroup = u.releaseGroup;
    if (u.releaseType !== undefined) patch.releaseType = u.releaseType;
    if (u.indexerFlags !== undefined) patch.indexerFlags = u.indexerFlags;
    return patch;
  }

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
