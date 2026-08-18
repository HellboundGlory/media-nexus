// SPDX-License-Identifier: MIT
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { extname, join } from "node:path";
import { LocalStorageProvider } from "@medianexus/integrations";
import { ensureAvailability, getMediaCredits, getMediaFiles, getQualityProfile, listPaged, removeMediaItem, requireFound, searchAndGrabRelease, titleSearchCondition, attachMatchedFormats, combine } from "../media/library.helpers";
import { ApiError, newEntityId } from "@medianexus/shared";
import type { RuntimeSettings } from "@medianexus/shared";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import { episodeQueryTag, parseEpisodeRelease, meetsCutoff } from "@medianexus/domain";
import type { CreateSeries, Quality, Release, SeriesType, UpdateSeriesBody } from "@medianexus/domain";
import { episodeFileName, resolvedSeriesFolderName } from "../media/naming.helpers";
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
      rootPath: join(series.rootFolderPath ?? "", resolvedSeriesFolderName(series)),
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
    return `${resolvedSeriesFolderName(series)}/Season ${season}/${fileName}`;
  }

  /** The series' media_file rows (DETAILPAGE-FE1) — feeds the season size-on-disk pill and any
   *  file-level display. Read-only, pure DB. Each row's episodeIds lets the frontend attribute
   *  a file to its season (via the already-fetched episode list). matchedFormats is computed
   *  live against current custom formats (SON-024). */
  async files(id: string): Promise<MediaFileRow[]> {
    const files = await getMediaFiles(this.db, "series", id);
    return attachMatchedFormats(this.db, files);
  }

  async list(q: { search?: string; monitored?: string; filter?: string; sort?: string; sortDir?: "asc" | "desc"; page?: number; pageSize?: number }) {
    // UNI-029: Series supports All/Monitored/Unmonitored (via `monitored`), but deliberately has
    // NO "missing" branch — the list response has no per-show file-completeness signal, so a
    // missing filter would be a fake condition (the controller also rejects `filter=missing`).
    const where = combine([
      titleSearchCondition(schema.series.title, q.search),
      q.monitored === "true" ? eq(schema.series.monitored, true) : undefined,
      q.monitored === "false" ? eq(schema.series.monitored, false) : undefined,
    ]);
    return listPaged<typeof schema.series.$inferSelect>(this.db, schema.series, where, q, {
      sortColumns: {
        title: schema.series.title,
        year: schema.series.firstAirYear,
        added: schema.series.addedAt,
        monitored: schema.series.monitored,
      },
    });
  }

  async get(id: string) {
    const rows = await this.db.select().from(schema.series).where(eq(schema.series.id, id)).limit(1);
    return requireFound(rows[0], "series", id);
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
      // null clears the folder-name override; omitted leaves it unchanged (see updateSeriesSchema).
      folderName: input.folderName !== undefined ? input.folderName : existing.folderName,
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
      folderName: input.folderName ?? null,
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
    return removeMediaItem(this.db, {
      events: this.events,
      recycleBin: this.recycleBin,
      logWarn: (msg) => this.logger.warn(msg),
    }, {
      mediaType: "series",
      id,
      rootFolderPath: row.rootFolderPath,
      folderName: resolvedSeriesFolderName(row),
      tmdbId: row.tmdbId,
      deleteFiles,
      addImportExclusion,
      publish: (events, sid) => events.publish(EventTypes.SeriesRemoved, { seriesId: sid }, { aggType: "series", aggId: sid }),
    });
  }

  /** Bulk operations (UNI-020) — fan out over the existing single-item methods (update()/
   *  remove()), never re-implementing their logic. Per-id success/failure is aggregated so a
   *  single bad id in a large selection is surfaced rather than silently dropping the batch. */
  async bulkEdit(ids: string[], patch: Partial<UpdateSeriesBody>): Promise<{ updated: string[]; failed: { id: string; error: string }[] }> {
    const updated: string[] = [];
    const failed: { id: string; error: string }[] = [];
    for (const id of ids) {
      try { await this.update(id, patch); updated.push(id); }
      catch (err) { failed.push({ id, error: (err as Error).message }); }
    }
    return { updated, failed };
  }

  /** Set tags across a selection. Add = union, Remove = set-difference, Replace = overwrite
   *  (empty tagIds clears). Writes through update(id, { tags }) so auto-tag rules layer on
   *  exactly as they do for a single-item tag edit. */
  async bulkTags(ids: string[], tagIds: string[], mode: "add" | "remove" | "replace"): Promise<{ updated: string[]; failed: { id: string; error: string }[] }> {
    const updated: string[] = [];
    const failed: { id: string; error: string }[] = [];
    for (const id of ids) {
      try {
        const row = await this.get(id);
        const current = row.tags ?? [];
        let next: string[];
        if (mode === "add") next = [...new Set([...current, ...tagIds])];
        else if (mode === "remove") next = current.filter((t) => !tagIds.includes(t));
        else next = [...tagIds]; // replace
        await this.update(id, { tags: next });
        updated.push(id);
      } catch (err) { failed.push({ id, error: (err as Error).message }); }
    }
    return { updated, failed };
  }

  /** Remove a whole selection at once, forwarding the same opt-in delete options each item. */
  async bulkDelete(ids: string[], opts: { deleteFiles?: boolean; addImportExclusion?: boolean }): Promise<{ updated: string[]; failed: { id: string; error: string }[] }> {
    const updated: string[] = [];
    const failed: { id: string; error: string }[] = [];
    for (const id of ids) {
      try { await this.remove(id, opts); updated.push(id); }
      catch (err) { failed.push({ id, error: (err as Error).message }); }
    }
    return { updated, failed };
  }

  /** Bulk rename (UNI-027): pass every file id for each selected title to the existing
   *  rename(); files whose computed path already matches are no-ops (renamed:false), so we let
   *  rename() sort out what to touch rather than pre-filtering. Per-title failures are
   *  aggregated so one bad id never aborts the batch. */
  async bulkRename(ids: string[]): Promise<{ titlesProcessed: number; filesRenamed: number; failed: { id: string; error: string }[] }> {
    let titlesProcessed = 0;
    let filesRenamed = 0;
    const failed: { id: string; error: string }[] = [];
    for (const id of ids) {
      try {
        const files = await this.files(id);
        const res = await this.rename(id, files.map((f) => f.id));
        titlesProcessed++;
        filesRenamed += res.renamed;
      } catch (err) { failed.push({ id, error: (err as Error).message }); }
    }
    return { titlesProcessed, filesRenamed, failed };
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
    return getMediaCredits(this.db, "series", seriesId);
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
    return searchAndGrabRelease(this.indexers, {
      mediaType: "series",
      mediaId: series.id,
      buildQuery: () => query,
      matches: (r) => episodeAutoMatches(seriesType, target, r.title),
      publishFailure: (error) => {
        this.logger.warn(`auto-search grab failed for "${series.title}" ${query}: ${error}`);
        this.events.publish(EventTypes.DownloadClientFailed, { seriesId: series.id, error });
      },
    });
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

  /** Cutoff Unmet (NAV-1 Phase 0): monitored episodes that already have a file whose quality is
   *  below their series' quality profile cutoff (or outside its allowed qualities). Uses the
   *  shared `meetsCutoff()` — the file quality comes from the episode's media_file via the
   *  `media_file_id` FK (J3). Episodes with no series profile have no cutoff and are never
   *  "unmet". Overfetches past `limit` to absorb per-row rejects, then slices. */
  async cutoffUnmet(limit = 50): Promise<{
    id: string; mediaType: "series"; seriesId: string; episodeNumber: number; title: string;
    airDateUtc: string | null; monitored: boolean; hasFile: boolean; seasonNumber: number;
    seriesTitle: string; seriesType: string; seriesAlternateTitles: string[];
    quality: Quality | null; cutoffQualityId: number | null;
  }[]> {
    const rows = await this.db
      .select({
        episode: schema.episode,
        seasonNumber: schema.season.seasonNumber,
        series: { id: schema.series.id, title: schema.series.title, seriesType: schema.series.seriesType, alternateTitles: schema.series.alternateTitles, qualityProfileId: schema.series.qualityProfileId },
      })
      .from(schema.episode)
      .innerJoin(schema.season, eq(schema.episode.seasonId, schema.season.id))
      .innerJoin(schema.series, eq(schema.episode.seriesId, schema.series.id))
      .where(and(eq(schema.episode.monitored, true), eq(schema.episode.hasFile, true)))
      .orderBy(asc(schema.episode.airDateUtc))
      .limit(Math.max(limit * 4, 200));
    const out: { id: string; mediaType: "series"; seriesId: string; episodeNumber: number; title: string; airDateUtc: string | null; monitored: boolean; hasFile: boolean; seasonNumber: number; seriesTitle: string; seriesType: string; seriesAlternateTitles: string[]; quality: Quality | null; cutoffQualityId: number | null }[] = [];
    for (const r of rows) {
      const profile = await getQualityProfile(this.db, r.series.qualityProfileId);
      if (!profile || !r.episode.mediaFileId) continue;
      const file = await this.db.select().from(schema.mediaFile).where(eq(schema.mediaFile.id, r.episode.mediaFileId)).limit(1);
      if (!file[0]?.quality) continue;
      const quality = file[0].quality as Quality;
      if (meetsCutoff(profile, quality)) continue;
      out.push({
        ...r.episode, mediaType: "series", seriesId: r.series.id, quality, cutoffQualityId: profile.cutoffQualityId,
        seasonNumber: r.seasonNumber, seriesTitle: r.series.title, seriesType: r.series.seriesType, seriesAlternateTitles: r.series.alternateTitles ?? [],
      });
    }
    return out.slice(0, limit);
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
