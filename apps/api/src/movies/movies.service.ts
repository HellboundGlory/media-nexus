// SPDX-License-Identifier: MIT
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { extname, join } from "node:path";
import { newEntityId } from "@medianexus/shared";
import { ApiError } from "@medianexus/shared";
import type { RuntimeSettings } from "@medianexus/shared";
import { LocalStorageProvider } from "@medianexus/integrations";
import { combine, ensureAvailability, getMediaCredits, getMediaFiles, getQualityProfile, listPaged, removeMediaItem, requireFound, searchAndGrabRelease, titleSearchCondition, attachMatchedFormats } from "../media/library.helpers";
import { movieFileName, resolvedMovieFolderName } from "../media/naming.helpers";
import { runWrite, type MediaFileRow } from "../media/media-file.types";
import { RecycleBinService } from "../media/recycle-bin.service";
import { ConfigService } from "../system/config.service";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import { parseEpisodeRelease, titleMatches } from "@medianexus/domain";
import type { CreateMovie, MinimumAvailability, Quality, Release, UpdateMovieBody } from "@medianexus/domain";
import { hasMinimumAvailability, meetsCutoff, compareQuality } from "@medianexus/domain";
import { EventsService } from "../events/events.service";
import { EventTypes } from "@medianexus/events";
import { AutoTagsService } from "../auto-tags/auto-tags.service";
import { IndexersService } from "../indexers/indexers.service";

export interface ListQuery { search?: string; monitored?: string; filter?: string; sort?: string; sortDir?: "asc" | "desc"; page?: number; pageSize?: number }

/** One row of a rename preview (DETAILPAGE-BE4): what a file would be renamed to now. */
export interface RenamePreviewItem {
  mediaFileId: string;
  currentPath: string;
  newPath: string;
  changed: boolean;
}

/** The wrapped rename-preview response (FILEMGMT-1): the title's resolved folder path and its
 *  naming template are returned so the frontend can render the modal's info panel. */
export interface RenamePreviewEnvelope {
  rootPath: string;
  namingPattern: string;
  items: RenamePreviewItem[];
}

/** A media_file row as exposed by GET /movies|series/:id/files (DETAILPAGE-FE1). Re-exported
 *  from ../media/media-file.types so consumers import it from one place. */
export type { MediaFileRow } from "../media/media-file.types";

export interface WantedMovie {
  id: string;
  mediaType: "movie";
  title: string;
  releaseDate: string | null;
  minimumAvailability: MinimumAvailability;
  monitored: boolean;
  hasFile: boolean;
}

@Injectable()
export class MoviesService {
  private readonly logger = new Logger(MoviesService.name);
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly events: EventsService,
    private readonly autoTags: AutoTagsService,
    private readonly config: ConfigService,
    private readonly indexers: IndexersService,
    private readonly recycleBin: RecycleBinService,
  ) {}

  /** Read-only rename preview (DETAILPAGE-BE4): for each media_file of this movie, recompute
   *  what the relative path WOULD be under the current naming template and compare against the
   *  stored path. Purely derived from DB rows — no filesystem access, no storage provider
   *  import. Mirrors acquisition.service's movie assembly exactly: folder =
   *  movieFolderName(title, releaseDate), filename = movieFileName(cfg, ...), joined with the
   *  existing extension, made relative the same way import does. */
  async renamePreview(id: string): Promise<RenamePreviewEnvelope> {
    const movie = await this.get(id);
    const cfg = await this.config.get();
    const folderName = resolvedMovieFolderName(movie);
    const items = (await this.files(id)).map((f) => {
      const newPath = this.computeNewRelativePath(cfg, movie, f);
      return { mediaFileId: f.id, currentPath: f.relativePath, newPath, changed: newPath !== f.relativePath };
    });
    return {
      rootPath: join(movie.rootFolderPath ?? "", folderName),
      namingPattern: cfg["media.naming"].movies,
      items,
    };
  }

  /** Execute a real rename: move the requested files on disk and update their relativePath.
   *  Only files whose id is in `mediaFileIds` are touched; any requested file that is already
   *  `changed: false` (nothing to do) is skipped. Uses the same computeNewRelativePath the
   *  preview derives from, so execute always matches what the preview showed. */
  async rename(id: string, mediaFileIds: string[]): Promise<{
    renamed: number;
    results: { mediaFileId: string; renamed: boolean; error?: string }[];
  }> {
    const movie = await this.get(id);
    const cfg = await this.config.get();
    const root = movie.rootFolderPath ?? "";
    const asked = new Set(mediaFileIds);
    const storage = new LocalStorageProvider();
    const results: { mediaFileId: string; renamed: boolean; error?: string }[] = [];
    let renamed = 0;
    for (const f of (await this.files(id))) {
      if (!asked.has(f.id)) continue; // requested-only — a file not in the list is left alone
      const newRelative = this.computeNewRelativePath(cfg, movie, f);
      if (newRelative === f.relativePath) {
        // already correct — nothing to move or update (matches preview's changed:false)
        results.push({ mediaFileId: f.id, renamed: false });
        continue;
      }
      // Both absolute paths are root-relative + title-folder prefix (relativePath/newRelative),
      // so join against the root folder, not a pre-appended title folder.
      const oldAbs = join(root, f.relativePath);
      const newAbs = join(root, newRelative);
      try {
        await storage.move(oldAbs, newAbs); // rename-with-copy-fallback built in, don't reimplement
        await runWrite(this.db, this.db.update(schema.mediaFile).set({ relativePath: newRelative }).where(eq(schema.mediaFile.id, f.id)));
        renamed++;
        results.push({ mediaFileId: f.id, renamed: true });
      } catch (err) {
        results.push({ mediaFileId: f.id, renamed: false, error: (err as Error).message });
      }
    }
    return { renamed, results };
  }

  /** The single source of truth for what a movie file's relative path WOULD be under the
   *  current naming template — used by both renamePreview and the rename execute so they
   *  can never derive two different answers for the same file. */
  private computeNewRelativePath(
    cfg: RuntimeSettings,
    movie: typeof schema.movie.$inferSelect,
    f: MediaFileRow,
  ): string {
    const folder = resolvedMovieFolderName(movie);
    const fileName = `${movieFileName(cfg, movie.title, movie.releaseDate, f.quality as Quality)}${extname(f.relativePath)}`;
    return `${folder}/${fileName}`;
  }

  /** The movie's media_file rows (DETAILPAGE-FE1) — feeds the movie File panel. Read-only,
   *  pure DB. A movie has no episodeIds; the shape is shared with the series /files endpoint.
   *  matchedFormats is computed live against current custom formats (SON-024). */
  async files(id: string): Promise<MediaFileRow[]> {
    const files = await getMediaFiles(this.db, "movie", id);
    return attachMatchedFormats(this.db, files);
  }

  async list(q: ListQuery) {
    // UNI-029: `filter=missing` is the more specific ask — when present it wins over (and
    // suppresses) the otherwise-contradictory `monitored=true/false` conditions.
    const where = combine([
      titleSearchCondition(schema.movie.title, q.search),
      q.filter === "missing" ? undefined
        : q.monitored === "true" ? eq(schema.movie.monitored, true)
        : q.monitored === "false" ? eq(schema.movie.monitored, false)
        : undefined,
      q.filter === "missing" ? and(eq(schema.movie.monitored, true), eq(schema.movie.hasFile, false)) : undefined,
    ]);
    return listPaged<typeof schema.movie.$inferSelect>(this.db, schema.movie, where, q, {
      // Movie "year" is releaseDate; series uses firstAirYear (different column/type) — the
      // caller supplies the map so the two never get conflated.
      sortColumns: {
        title: schema.movie.title,
        year: schema.movie.releaseDate,
        added: schema.movie.addedAt,
        monitored: schema.movie.monitored,
      },
    });
  }

  async get(id: string) {
    const rows = await this.db.select().from(schema.movie).where(eq(schema.movie.id, id)).limit(1);
    return requireFound(rows[0], "movie", id);
  }

  /** On-demand "Search + auto-grab" for a single movie (DETAILPAGE-FE1). Mirrors
   *  RssSyncService.tryGrabMovie()'s proven search → title-match → pickBest → grab
   *  composition (on-demand one-click version of the whole-library RSS sweep). `grabbed:
   *  false` means no acceptable release was found — a normal outcome, not an error; only a
   *  genuine grab failure sets `error`. */
  async autoSearchMovie(mediaId: string): Promise<{ grabbed: boolean; release?: Release; error?: string }> {
    const movie = await this.get(mediaId);
    const year = movie.releaseDate ? Number(movie.releaseDate.slice(0, 4)) : undefined;
    return searchAndGrabRelease(this.indexers, {
      mediaType: "movie",
      mediaId,
      buildQuery: () => (year ? `${movie.title} ${year}` : movie.title),
      matches: (r) => movieReleaseMatches(r, movie.title, year),
      publishFailure: (error) => {
        this.logger.warn(`auto-search grab failed for "${movie.title}": ${error}`);
        this.events.publish(EventTypes.DownloadClientFailed, { movieId: mediaId, error });
      },
    });
  }

  /** Cast & crew for a movie (DETAILPAGE-BE2) — split by role, cast ordered top-billed first. */
  async credits(id: string): Promise<{ cast: typeof schema.mediaCredit.$inferSelect[]; crew: typeof schema.mediaCredit.$inferSelect[] }> {
    return getMediaCredits(this.db, "movie", id);
  }

  /** Edit a movie (roadmap P1, gap report C5). Partial body; omitted fields are untouched,
   *  `qualityProfileId: null` clears the assignment. Bumps `updatedAt`. */
  async update(id: string, input: UpdateMovieBody) {
    const existing = await this.get(id);
    const merged = {
      title: input.title ?? existing.title,
      monitored: input.monitored ?? existing.monitored,
      qualityProfileId: input.qualityProfileId !== undefined ? input.qualityProfileId : existing.qualityProfileId,
      rootFolderPath: input.rootFolderPath ?? existing.rootFolderPath,
      // null clears the folder-name override; omitted leaves it unchanged (matches the merge
      // semantics of the other partial fields — see updateMovieSchema docs).
      folderName: input.folderName !== undefined ? input.folderName : existing.folderName,
      minimumAvailability: input.minimumAvailability ?? existing.minimumAvailability,
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
      year: existing.releaseDate ? Number(existing.releaseDate.slice(0, 4)) : null,
    });
    await this.db.update(schema.movie).set({ ...merged, tags, updatedAt }).where(eq(schema.movie.id, id));
    return { ...existing, ...merged, tags, updatedAt };
  }

  async create(input: CreateMovie) {
    if (input.tmdbId) {
      const dup = await this.db.select().from(schema.movie).where(eq(schema.movie.tmdbId, input.tmdbId)).limit(1);
      if (dup[0]) throw new ApiError({ code: "CONFLICT", message: `Movie with tmdbId ${input.tmdbId} already exists` });
    }
    const now = new Date().toISOString();
    const id = newEntityId("m");
    const row = {
      id,
      tmdbId: input.tmdbId ?? null,
      imdbId: input.imdbId ?? null,
      title: input.title,
      originalTitle: null,
      overview: input.overview ?? "",
      status: input.releaseDate ? "released" : "unknown",
      releaseDate: input.releaseDate ?? null,
      monitored: input.monitored ?? true,
      qualityProfileId: input.qualityProfileId ?? null,
      rootFolderPath: input.rootFolderPath ?? "",
      folderName: input.folderName ?? null,
      minimumAvailability: input.minimumAvailability,
      genres: [],
      images: [],
      tags: input.tags ?? [],
      hasFile: false,
      addedAt: now,
      updatedAt: now,
    };
    // Auto-tag (roadmap P3, gap C6): fold rule-based tag changes into the same insert, so a new
    // movie gets its auto tags in one atomic write (no second write/event).
    row.tags = await this.autoTags.appliedTags({
      tags: row.tags,
      genres: row.genres ?? [],
      status: row.status,
      monitored: row.monitored,
      rootFolderPath: row.rootFolderPath,
      qualityProfileId: row.qualityProfileId,
      year: row.releaseDate ? Number(row.releaseDate.slice(0, 4)) : null,
    });
    await this.db.insert(schema.movie).values(row);
    await ensureAvailability(this.db, "movie", id);
    this.events.publish(EventTypes.MovieAdded, { movieId: id, title: row.title }, { aggType: "movie", aggId: id });
    return row;
  }

  async remove(id: string, opts: { deleteFiles?: boolean; addImportExclusion?: boolean } = {}) {
    const row = await this.get(id);
    const { deleteFiles = false, addImportExclusion = false } = opts;
    return removeMediaItem(this.db, {
      events: this.events,
      recycleBin: this.recycleBin,
      logWarn: (msg) => this.logger.warn(msg),
    }, {
      mediaType: "movie",
      id,
      rootFolderPath: row.rootFolderPath,
      folderName: resolvedMovieFolderName(row),
      tmdbId: row.tmdbId,
      deleteFiles,
      addImportExclusion,
      publish: (events, mid) => events.publish(EventTypes.MovieRemoved, { movieId: mid }, { aggType: "movie", aggId: mid }),
    });
  }

  /** Bulk operations (UNI-020) — fan out over the existing single-item methods (update()/
   *  remove()), never re-implementing their logic. Per-id success/failure is aggregated so a
   *  single bad id in a large selection is surfaced rather than silently dropping the batch. */
  async bulkEdit(ids: string[], patch: Partial<UpdateMovieBody>): Promise<{ updated: string[]; failed: { id: string; error: string }[] }> {
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

  /** Want/Missing: monitored movies without a file, past their minimum-availability gate
   *  (roadmap C1). The gate depends on Date.now(), so it can't be pushed into SQL —
   *  overfetch past `limit` and filter in JS, mirroring the shape of
   *  SeriesService.wantedMissing(). */
  async wantedMissing(limit = 50): Promise<WantedMovie[]> {
    const rows = await this.db.select().from(schema.movie)
      .where(and(eq(schema.movie.monitored, true), eq(schema.movie.hasFile, false)))
      .orderBy(asc(schema.movie.releaseDate))
      .limit(Math.max(limit * 4, 200));
    return rows
      .filter((m) => hasMinimumAvailability({ minimumAvailability: m.minimumAvailability as MinimumAvailability, releaseDate: m.releaseDate }))
      .slice(0, limit)
      .map((m) => ({
        id: m.id, mediaType: "movie" as const, title: m.title, releaseDate: m.releaseDate,
        minimumAvailability: m.minimumAvailability as MinimumAvailability, monitored: m.monitored, hasFile: m.hasFile,
      }));
  }

  /** Cutoff Unmet (NAV-1 Phase 0): monitored movies that already have a file whose quality is
   *  below their quality profile's cutoff (or outside its allowed qualities). Uses the shared
   *  `meetsCutoff()` — no reimplementation. `hasFile` is a stored flag, so the real per-file
   *  quality comes from the media_file rows; the best-quality file is the one judged (upgrades
   *  key on the best held file elsewhere too). Titles with no assigned profile have no cutoff
   *  and are never "unmet". Overfetches past `limit` to absorb per-row rejects, then slices. */
  async cutoffUnmet(limit = 50): Promise<{
    id: string; mediaType: "movie"; title: string; releaseDate: string | null;
    monitored: boolean; hasFile: boolean; quality: Quality | null; cutoffQualityId: number | null;
  }[]> {
    const rows = await this.db.select().from(schema.movie)
      .where(and(eq(schema.movie.monitored, true), eq(schema.movie.hasFile, true)))
      .orderBy(asc(schema.movie.releaseDate))
      .limit(Math.max(limit * 4, 200));
    const out: { id: string; mediaType: "movie"; title: string; releaseDate: string | null; monitored: boolean; hasFile: boolean; quality: Quality | null; cutoffQualityId: number | null }[] = [];
    for (const m of rows) {
      const profile = await getQualityProfile(this.db, m.qualityProfileId);
      if (!profile) continue;
      const files = await this.db.select().from(schema.mediaFile)
        .where(and(eq(schema.mediaFile.mediaType, "movie"), eq(schema.mediaFile.mediaId, m.id)));
      const withQuality = files.filter((f) => f.quality != null) as { quality: Quality; relativePath: string }[];
      if (withQuality.length === 0) continue;
      const best = withQuality.reduce((a, b) => (compareQuality(b.quality, a.quality) > 0 ? b : a));
      if (meetsCutoff(profile, best.quality)) continue;
      out.push({
        id: m.id, mediaType: "movie", title: m.title, releaseDate: m.releaseDate,
        monitored: m.monitored, hasFile: true, quality: best.quality, cutoffQualityId: profile.cutoffQualityId,
      });
    }
    return out.slice(0, limit);
  }
}

/** Whether a movie release title matches a wanted movie — the same tolerant title/year
 *  match RssSyncService.matchesMovie() applies to the whole-library sweep: no SxxExx to
 *  match on, so use the year the parser extracted (tolerant of ±1 for festival/regional
 *  release-date drift across a calendar-year boundary) plus a real title match. */
function movieReleaseMatches(r: Release, title: string, year: number | undefined): boolean {
  const m = parseEpisodeRelease(r.title);
  if (year !== undefined && m.year !== undefined && Math.abs(m.year - year) > 1) return false;
  return titleMatches(m.seriesTitle, title);
}
