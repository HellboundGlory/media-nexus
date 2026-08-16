// SPDX-License-Identifier: MIT
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { extname, join } from "node:path";
import { LocalStorageProvider } from "@medianexus/integrations";
import { deletePolymorphicRows, deletePolymorphicRowsAsync, ensureAvailability, listPaged, titleSearchCondition } from "../media/library.helpers";
import { ApiError, newEntityId } from "@medianexus/shared";
import type { RuntimeSettings } from "@medianexus/shared";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import { episodeQueryTag, parseEpisodeRelease, pickBest } from "@medianexus/domain";
import type { CreateSeries, Quality, Release, SeriesType, UpdateSeriesBody } from "@medianexus/domain";
import { seriesFolderName, episodeFileName } from "../media/naming.helpers";
import { selectMediaFiles, runWrite, type MediaFileRow } from "../media/media-file.types";
import { RecycleBinService } from "../media/recycle-bin.service";
import { ConfigService } from "../system/config.service";
import { EventsService } from "../events/events.service";
import { EventTypes } from "@medianexus/events";
import { AutoTagsService } from "../auto-tags/auto-tags.service";
import type { RenamePreviewEnvelope } from "../movies/movies.service";
import { IndexersService } from "../indexers/indexers.service";

@Injectable()
export class SeriesService {
  private readonly logger = new Logger(SeriesService.name);
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly events: EventsService,
    private readonly autoTags: AutoTagsService,
    private readonly config: ConfigService,
    private readonly indexers: IndexersService,
    private readonly recycleBin: RecycleBinService,
  ) {}

  /** Read-only rename preview (DETAILPAGE-BE4) — series files need their episode number/title
   *  looked up from the file's episodeIds, exactly as acquisition builds epNumberById/
   *  epTitleById. Purely derived from DB rows, no filesystem/storage access. Mirrors
   *  acquisition's series assembly: folder = seriesFolderName(title)/Season {n}, filename =
   *  episodeFileName(cfg, ...), joined with the existing extension. */
  async renamePreview(id: string, seasonNumber?: number): Promise<RenamePreviewEnvelope> {
    const series = await this.get(id);
    const cfg = await this.config.get();
    const allFiles = await selectMediaFiles(this.db, "series", id);
    // Load the episodes for every file at once (id -> episodeNumber/title + seasonNumber via the
    // season join) so we can build the same epNumberById/epTitleById maps acquisition uses.
    const maps = allFiles.length === 0 ? null : await this.loadEpisodeMaps(allFiles);
    const files = seasonNumber === undefined ? allFiles : this.filterFilesBySeason(allFiles, maps, seasonNumber);
    const items = files.map((f) => {
      const newPath = maps ? this.computeNewRelativePath(cfg, series, maps, f) : f.relativePath;
      return { mediaFileId: f.id, currentPath: f.relativePath, newPath, changed: newPath !== f.relativePath };
    });
    return {
      rootPath: join(series.rootFolderPath ?? "", seriesFolderName(series.title)),
      namingPattern: cfg["media.naming"].episodes,
      items,
    };
  }

  /** Execute a real rename: move the requested files on disk and update their relativePath.
   *  Same shape/semantics as MoviesService.rename — requested-only, skips already-correct files,
   *  uses the same computeNewRelativePath the preview derives from. */
  async rename(id: string, mediaFileIds: string[], seasonNumber?: number): Promise<{
    renamed: number;
    results: { mediaFileId: string; renamed: boolean; error?: string }[];
  }> {
    const series = await this.get(id);
    const cfg = await this.config.get();
    const allFiles = await selectMediaFiles(this.db, "series", id);
    const maps = allFiles.length === 0 ? null : await this.loadEpisodeMaps(allFiles);
    const files = seasonNumber === undefined ? allFiles : this.filterFilesBySeason(allFiles, maps, seasonNumber);
    const root = series.rootFolderPath ?? "";
    const asked = new Set(mediaFileIds);
    const storage = new LocalStorageProvider();
    const results: { mediaFileId: string; renamed: boolean; error?: string }[] = [];
    let renamed = 0;
    for (const f of files) {
      if (!asked.has(f.id)) continue; // requested-only — a file not in the list is left alone
      const newRelative = maps ? this.computeNewRelativePath(cfg, series, maps, f) : f.relativePath;
      if (newRelative === f.relativePath) {
        // already correct — nothing to move or update (matches preview's changed:false)
        results.push({ mediaFileId: f.id, renamed: false });
        continue;
      }
      // Both absolute paths are root-relative + title-folder prefix — join against the root.
      try {
        await storage.move(join(root, f.relativePath), join(root, newRelative));
        await runWrite(this.db, this.db.update(schema.mediaFile).set({ relativePath: newRelative }).where(eq(schema.mediaFile.id, f.id)));
        renamed++;
        results.push({ mediaFileId: f.id, renamed: true });
      } catch (err) {
        results.push({ mediaFileId: f.id, renamed: false, error: (err as Error).message });
      }
    }
    return { renamed, results };
  }

  /** Fetch the episode-number/title/season maps shared by both the preview and the execute —
   *  keyed by episode id, mirroring the epNumberById/epTitleById maps acquisition builds. */
  private async loadEpisodeMaps(files: MediaFileRow[]): Promise<{
    number: Map<string, number>;
    title: Map<string, string>;
    season: Map<string, number>;
  }> {
    const allEpisodeIds = [...new Set(files.flatMap((f) => f.episodeIds ?? []))];
    const epRows = allEpisodeIds.length === 0 ? []
      : await this.db.select({
          id: schema.episode.id,
          seriesId: schema.episode.seriesId,
          seasonNumber: schema.season.seasonNumber,
          episodeNumber: schema.episode.episodeNumber,
          title: schema.episode.title,
        }).from(schema.episode)
          .innerJoin(schema.season, eq(schema.episode.seasonId, schema.season.id))
          .where(inArray(schema.episode.id, allEpisodeIds));
    return {
      number: new Map(epRows.map((e) => [e.id, e.episodeNumber])),
      title: new Map(epRows.map((e) => [e.id, e.title])),
      season: new Map(epRows.map((e) => [e.id, e.seasonNumber ?? 0])),
    };
  }

  /** Restrict a series' files to one season (for the season-scoped Preview Rename / Manage
   *  Episodes). A file's season is inferred from its first episode; pack files with no episode
   *  identity belong to no season and are excluded from a season-scoped view. */
  private filterFilesBySeason(
    files: MediaFileRow[],
    maps: { number: Map<string, number>; title: Map<string, string>; season: Map<string, number> } | null,
    seasonNumber: number,
  ): MediaFileRow[] {
    if (!maps) return [];
    return files.filter((f) => {
      const ids = f.episodeIds ?? [];
      return ids.length > 0 && maps.season.get(ids[0]) === seasonNumber;
    });
  }

  /** The single source of truth for what a series file's relative path WOULD be under the
   *  current naming template. Unmatched pack files (no episode identity) stay unchanged. */
  private computeNewRelativePath(
    cfg: RuntimeSettings,
    series: typeof schema.series.$inferSelect,
    maps: { number: Map<string, number>; title: Map<string, string>; season: Map<string, number> },
    f: MediaFileRow,
  ): string {
    const ids = f.episodeIds ?? [];
    if (ids.length === 0) return f.relativePath;
    const season = maps.season.get(ids[0]) ?? 0;
    const episodes = ids.map((epId) => ({ number: maps.number.get(epId) ?? 0, title: maps.title.get(epId) ?? "" }));
    const fileName = `${episodeFileName(cfg, series.title, season, episodes, f.quality as Quality)}${extname(f.relativePath)}`;
    return `${seriesFolderName(series.title)}/Season ${season}/${fileName}`;
  }

  /** The series' media_file rows (DETAILPAGE-FE1) — feeds the season size-on-disk pill and any
   *  file-level display. Read-only, pure DB. Each row's episodeIds lets the frontend attribute
   *  a file to its season (via the already-fetched episode list). */
  async files(id: string): Promise<MediaFileRow[]> {
    await this.get(id);
    return selectMediaFiles(this.db, "series", id);
  }

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
    const tags = await this.autoTags.appliedTags({
      tags: merged.tags,
      genres: existing.genres ?? [],
      status: existing.status,
      monitored: merged.monitored,
      rootFolderPath: merged.rootFolderPath,
      qualityProfileId: merged.qualityProfileId,
      year: existing.firstAirYear,
      network: existing.network,
      seriesType: merged.seriesType,
    });
    await this.db.update(schema.series).set({ ...merged, tags, updatedAt }).where(eq(schema.series.id, id));
    return { ...existing, ...merged, tags, updatedAt };
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
    row.tags = await this.autoTags.appliedTags({
      tags: row.tags,
      genres: row.genres ?? [],
      status: row.status,
      monitored: row.monitored,
      rootFolderPath: row.rootFolderPath,
      qualityProfileId: row.qualityProfileId,
      year: row.firstAirYear,
      network: row.network,
      seriesType: row.seriesType,
    });
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

  async remove(id: string, opts: { deleteFiles?: boolean; addImportExclusion?: boolean } = {}) {
    const row = await this.get(id);
    const { deleteFiles = false, addImportExclusion = false } = opts;
    // Before the DB cascade: physically delete each file and the title's folder when requested
    // (opt-in — a bare DELETE on its own does nothing to disk, matching upstream).
    if (deleteFiles) await this.deleteFilesFromDisk(row);
    // Only the polymorphic tables need a hand-written delete here — season/episode cascade
    // automatically via their DB-level FK to series (roadmap P0.7) once the series row
    // itself is deleted.
    if (this.db.dbDialect === "postgres") {
      // better-sqlite3's native tx wrapper needs a sync callback; node-postgres needs async
      // (P2 item 12 Stage 2) — two irreconcilable signatures, so Postgres gets its own body.
      await this.db.transaction(async (tx) => {
        await deletePolymorphicRowsAsync(tx, "series", id);
        await tx.delete(schema.series).where(eq(schema.series.id, id));
        // C2 import lists: only exclude from re-import when explicitly requested (opt-in).
        if (addImportExclusion && row.tmdbId != null) {
          await tx.insert(schema.importExclusion).values({
            id: `excl-series-${row.tmdbId}`, mediaType: "series", externalId: String(row.tmdbId),
            reason: "removed from library", createdAt: new Date().toISOString(),
          }).onConflictDoNothing();
        }
      });
    } else {
      this.db.transaction((tx) => {
        deletePolymorphicRows(tx, "series", id);
        tx.delete(schema.series).where(eq(schema.series.id, id)).run();
        // C2 import lists: only exclude from re-import when explicitly requested (opt-in).
        if (addImportExclusion && row.tmdbId != null) {
          tx.insert(schema.importExclusion).values({
            id: `excl-series-${row.tmdbId}`, mediaType: "series", externalId: String(row.tmdbId),
            reason: "removed from library", createdAt: new Date().toISOString(),
          }).onConflictDoNothing().run();
        }
      });
    }
    this.events.publish(EventTypes.SeriesRemoved, { seriesId: id }, { aggType: "series", aggId: id });
    return { removed: id };
  }

  /** Move every series file into the recycle bin, then remove the title's folder itself
   *  (recursive — also removes untracked extras/subtitles, matching upstream). A file already
   *  missing on disk is wrapped + logged; a folder-delete failure surfaces normally. */
  private async deleteFilesFromDisk(series: typeof schema.series.$inferSelect): Promise<void> {
    const files = await this.db.select().from(schema.mediaFile)
      .where(and(eq(schema.mediaFile.mediaType, "series"), eq(schema.mediaFile.mediaId, series.id)));
    const root = series.rootFolderPath ?? "";
    const folder = join(root, seriesFolderName(series.title));
    const storage = new LocalStorageProvider();
    for (const f of files) {
      // relativePath is root-relative and includes the title-folder prefix — no double join.
      const abs = join(root, f.relativePath);
      try {
        await this.recycleBin.dispose(abs);
      } catch (err) {
        this.logger.warn(`Failed to dispose series file ${abs}: ${(err as Error).message}`);
      }
    }
    await storage.delete(folder);
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

  /** Cast & crew for a series (DETAILPAGE-BE2) — split by role, cast ordered top-billed first. */
  async credits(seriesId: string): Promise<{ cast: typeof schema.mediaCredit.$inferSelect[]; crew: typeof schema.mediaCredit.$inferSelect[] }> {
    await this.get(seriesId);
    const rows = await this.db.select().from(schema.mediaCredit)
      .where(and(eq(schema.mediaCredit.mediaType, "series"), eq(schema.mediaCredit.mediaId, seriesId)))
      .orderBy(asc(schema.mediaCredit.sortOrder));
    return {
      cast: rows.filter((r) => r.role === "cast"),
      crew: rows.filter((r) => r.role === "crew"),
    };
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

  /** On-demand "Search + auto-grab" for a single episode (DETAILPAGE-FE1). `grabbed:
   *  false` means no acceptable release was found — a normal outcome, not an error; only a
   *  genuine grab failure sets `error`. */
  async autoSearchEpisode(seriesId: string, episodeId: string): Promise<{ grabbed: boolean; release?: Release; error?: string }> {
    const series = await this.get(seriesId);
    const row = await this.episodeAutoRow(seriesId, episodeId);
    if (!row) throw ApiError.notFound("episode", episodeId);
    return this.searchAndGrabTarget(series, row);
  }

  /** On-demand "Search + auto-grab" for a whole season (DETAILPAGE-FE2): runs the same
   *  search → match → pickBest → grab composition as autoSearchEpisode over every episode
   *  in the season that does not already have a file (skip ones that do — the per-episode
   *  button disables on hasFile, this keeps that guard at the loop level). Returns a
   *  per-episode summary plus the counts. */
  async autoSearchSeason(seriesId: string, seasonNumber: number): Promise<{
    attempted: number;
    grabbed: number;
    results: { episodeId: string; grabbed: boolean; release?: Release; error?: string }[];
  }> {
    const series = await this.get(seriesId);
    const rows = await this.episodeAutoRows(seriesId, seasonNumber);
    const results: { episodeId: string; grabbed: boolean; release?: Release; error?: string }[] = [];
    let grabbed = 0;
    for (const row of rows) {
      if (row.episode.hasFile) continue;
      const r = await this.searchAndGrabTarget(series, row);
      if (r.grabbed) grabbed++;
      results.push({ episodeId: row.episode.id, ...r });
    }
    return { attempted: results.length, grabbed, results };
  }

  /** Fetch one episode of a series joined with its season number (the shape the shared
   *  search/grab helper targets), or null when it doesn't belong to the series. */
  private async episodeAutoRow(
    seriesId: string, episodeId: string,
  ): Promise<{ episode: typeof schema.episode.$inferSelect; seasonNumber: number } | null> {
    const rows = await this.db
      .select({ episode: schema.episode, seasonNumber: schema.season.seasonNumber })
      .from(schema.episode)
      .innerJoin(schema.season, eq(schema.episode.seasonId, schema.season.id))
      .where(and(eq(schema.episode.id, episodeId), eq(schema.episode.seriesId, seriesId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Fetch every episode of a season, joined with its season number, ordered by episode number. */
  private async episodeAutoRows(
    seriesId: string, seasonNumber: number,
  ): Promise<{ episode: typeof schema.episode.$inferSelect; seasonNumber: number }[]> {
    return this.db
      .select({ episode: schema.episode, seasonNumber: schema.season.seasonNumber })
      .from(schema.episode)
      .innerJoin(schema.season, eq(schema.episode.seasonId, schema.season.id))
      .where(and(eq(schema.episode.seriesId, seriesId), eq(schema.season.seasonNumber, seasonNumber)))
      .orderBy(asc(schema.episode.episodeNumber));
  }

  /** The shared search → title/target match → pickBest → grab composition both the
   *  per-episode and per-season auto-search use (DETAILPAGE-FE2), so the matching/picking
   *  logic lives in exactly one place rather than a third near-duplicate of RssSyncService's
   *  tryGrabEpisode. `grabbed: false` = no acceptable release found (normal); only a genuine
   *  grab failure sets `error`. */
  private async searchAndGrabTarget(
    series: typeof schema.series.$inferSelect,
    row: { episode: typeof schema.episode.$inferSelect; seasonNumber: number },
  ): Promise<{ grabbed: boolean; release?: Release; error?: string }> {
    const seriesType = series.seriesType as SeriesType;
    const target: EpisodeAutoTarget = {
      seasonNumber: row.seasonNumber,
      episodeNumber: row.episode.episodeNumber,
      airDateUtc: row.episode.airDateUtc,
      absoluteNumber: row.episode.absoluteNumber,
    };
    const query = episodeAutoQuery(seriesType, series.title, target);
    const res = await this.indexers.search({ mediaType: "series", mediaId: series.id, query, limit: 50 });
    if (res.releases.length === 0) return { grabbed: false };
    const candidates = res.releases.filter((r) => episodeAutoMatches(seriesType, target, r.title));
    const best = pickBest(candidates.map((r) => r.decision));
    if (!best) return { grabbed: false };
    try {
      await this.indexers.grab({ mediaType: "series", mediaId: series.id, releaseId: best.release.id, indexerId: best.release.indexerId, release: best.release });
      return { grabbed: true, release: best.release };
    } catch (err) {
      const error = (err as Error).message;
      this.logger.warn(`auto-search grab failed for "${series.title}" ${query}: ${error}`);
      this.events.publish(EventTypes.DownloadClientFailed, { seriesId: series.id, error });
      return { grabbed: false, error };
    }
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
    if (this.db.dbDialect === "postgres") {
      // better-sqlite3's native tx wrapper needs a sync callback; node-postgres needs async
      // (P2 item 12 Stage 2) — two irreconcilable signatures, so Postgres gets its own body.
      await this.db.transaction(async (tx) => {
        await tx.update(schema.season).set({ monitored }).where(eq(schema.season.id, seasonId));
        await tx.update(schema.episode).set({ monitored }).where(eq(schema.episode.seasonId, seasonId));
      });
    } else {
      this.db.transaction((tx) => {
        tx.update(schema.season).set({ monitored }).where(eq(schema.season.id, seasonId)).run();
        tx.update(schema.episode).set({ monitored }).where(eq(schema.episode.seasonId, seasonId)).run();
      });
    }
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

  /**
   * Calendar is now media-neutral (episode air dates + movie release dates) and lives in
   * MediaRepository.calendar() — see `apps/api/src/media/media.repository.ts`. It moved there
   * because a series-only home is wrong for movie data, and WantedController.calendar() routes
   * there now.
   */
}

/** The bits of an episode a per-episode auto-search needs to build a query and match
 *  releases against — mirror of the wanted-episode shape RssSyncService matches on. */
interface EpisodeAutoTarget {
  seasonNumber: number;
  episodeNumber: number;
  airDateUtc: string | null;
  absoluteNumber: number | null;
}

/** The per-episode indexer query, shaped by the series' numbering — the same
 *  seriesQuery() RssSyncService uses for its sweep: standard → SxxExx, daily → air date,
 *  anime → absolute number. */
function episodeAutoQuery(seriesType: SeriesType, seriesTitle: string, target: EpisodeAutoTarget): string {
  if (seriesType === "daily" && target.airDateUtc) {
    const date = target.airDateUtc.slice(0, 10).replace(/-/g, ".");
    return `${seriesTitle} ${date}`;
  }
  if (seriesType === "anime" && target.absoluteNumber != null) {
    return `${seriesTitle} ${target.absoluteNumber}`;
  }
  return `${seriesTitle} ${episodeQueryTag(target.seasonNumber, target.episodeNumber)}`;
}

/** Whether a release title matches the target episode, by the series' numbering — the
 *  same matchesTarget() RssSyncService applies to its sweep. Daily/anime prefer their own
 *  signal (date / absolute number) and fall back to S&E when one is present; absent data
 *  degrades to a no-match. */
function episodeAutoMatches(seriesType: SeriesType, target: EpisodeAutoTarget, title: string): boolean {
  const m = parseEpisodeRelease(title);
  if (seriesType === "daily") {
    if (m.dailyDate && target.airDateUtc && airDateMatches(target.airDateUtc, m.dailyDate)) return true;
    return m.season === target.seasonNumber && m.episodes.includes(target.episodeNumber);
  }
  if (seriesType === "anime") {
    if (m.absoluteNumber !== undefined && target.absoluteNumber != null && m.absoluteNumber === target.absoluteNumber) return true;
    return m.season === target.seasonNumber && m.episodes.includes(target.episodeNumber);
  }
  return m.season === target.seasonNumber && m.episodes.includes(target.episodeNumber);
}

/** Exact air-date match, else ±1 day for drift — copied from RssSyncService.airDateMatches. */
function airDateMatches(airDateUtc: string | null | undefined, date: string): boolean {
  if (!airDateUtc) return false;
  const day = airDateUtc.slice(0, 10);
  if (day === date) return true;
  const t = new Date(`${day}T00:00:00.000Z`).getTime();
  const base = new Date(`${date}T00:00:00.000Z`).getTime();
  return Number.isNaN(t) || Number.isNaN(base) ? false : Math.abs(t - base) <= 86400000;
}
