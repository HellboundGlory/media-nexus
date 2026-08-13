// SPDX-License-Identifier: MIT
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, count, eq, isNull } from "drizzle-orm";
import { extname, join, relative, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { ApiError, newEntityId } from "@medianexus/shared";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import { ConfigService } from "../system/config.service";
import type { RuntimeSettings } from "@medianexus/shared";
import { EventsService } from "../events/events.service";
import { EventTypes } from "@medianexus/events";
import { ProvidersService, type ConfiguredClient } from "../providers/demo.providers";
import { LocalStorageProvider, findLargestVideo, findAllVideos } from "@medianexus/integrations";
import type { ClientQueueItem, DownloadClientContract } from "@medianexus/integrations";
import {
  parseEpisodeRelease, episodeQueryTag, episodeTarget, compareQuality,
  decideImportFile, type KnownEpisode, type ImportRejection, type Quality,
} from "@medianexus/domain";
import { MediaRepository } from "../media/media.repository";
import { ensureAvailability, getQualityProfile } from "../media/library.helpers";
import { movieFolderName, seriesFolderName } from "../media/naming.helpers";
import { BlocklistService } from "../blocklist/blocklist.service";

/**
 * Acquisition: drives download clients, mirrors their queues into download_queue_entry,
 * monitors progress and performs the filesystem import when a download completes.
 *
 * Import (roadmap P0.5, gap report B2): enumerate every video file under a completed
 * download's content path, decide each one independently (`decideImportFile()` in
 * `packages/domain/src/import-decision.ts` — sample/incomplete-transfer detection, episode
 * matching, upgrade-vs-existing-file), then apply approved files. A season pack with N
 * episode files now imports all N, not the single largest one. Movies stay single-file —
 * there is no season-pack analog for a movie.
 */
/** Queue states the download monitor must never act on again. */
export const TERMINAL_QUEUE_STATUSES = new Set(["imported", "removed", "failed"]);

/** How many times an import may fail before the queue entry is parked as failed. */
export const MAX_IMPORT_ATTEMPTS = 3;

type QueueEntryRow = typeof schema.downloadQueueEntry.$inferSelect;

/** Where the completed download's payload was found. */
type ResolvedContent =
  | { kind: "file"; path: string; size: number }
  | { kind: "dir"; path: string };

interface ImportedFile {
  mediaFileId: string;
  path: string;
  size: number;
  hardlinked: boolean;
  episodeIds: string[];
}

interface RejectedFile {
  path: string;
  reasons: string[];
}

export interface ImportResult {
  imported: ImportedFile[];
  rejected: RejectedFile[];
}

@Injectable()
export class AcquisitionService {
  private readonly logger = new Logger(AcquisitionService.name);
  private readonly storage = new LocalStorageProvider();

  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly config: ConfigService,
    private readonly events: EventsService,
    private readonly providers: ProvidersService,
    private readonly media: MediaRepository,
    private readonly blocklist: BlocklistService,
  ) {}

  /** Poll every configured download client and import anything completed. */
  async syncAll(): Promise<{ clients: number; imported: number; updated: number }> {
    const clients = await this.providers.configuredDownloadClients();
    let imported = 0;
    let updated = 0;
    for (const client of clients) {
      try {
        const r = await this.syncForClient(client);
        imported += r.imported;
        updated += r.updated;
      } catch (err) {
        this.logger.warn(`client sync failed (${client.row?.id ?? "memory"}): ${(err as Error).message}`);
        this.events.publish(EventTypes.DownloadClientFailed, { clientId: client.row?.id ?? null, error: (err as Error).message });
      }
    }
    return { clients: clients.length, imported, updated };
  }

  async syncForClient(client: ConfiguredClient): Promise<{ imported: number; updated: number }> {
    const clientId = client.row?.id ?? null;
    const items = await client.provider.getQueue();
    let imported = 0;
    let updated = 0;
    for (const item of items) {
      const entry = await this.findEntry(clientId, item.downloadId);
      if (!entry) continue;
      // Terminal entries must never be re-processed. Some clients (SABnzbd) keep completed
      // items visible in their history after removal, so without this guard the monitor
      // would re-import the same download on every poll.
      if (TERMINAL_QUEUE_STATUSES.has(entry.status)) continue;
      if (item.status === "completed") {
        // Per-item isolation: one failing import must not abort the rest of this client's
        // queue, and must not be reported as a download-client outage.
        try {
          await this.importCompletedEntry(entry, item, client.provider);
          imported++;
        } catch (err) {
          await this.recordImportFailure(entry, err as Error);
        }
      } else {
        await this.db.update(schema.downloadQueueEntry)
          .set({
            status: item.status,
            progress: item.progress,
            size: item.size || entry.size,
            remainingTime: item.remainingTimeSeconds ?? null,
            errorMessage: item.errorMessage ?? null,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(schema.downloadQueueEntry.id, entry.id));
        updated++;
      }
    }
    return { imported, updated };
  }

  /**
   * Persist an import failure on the queue entry rather than losing it. Transient causes
   * (a mount not ready, a still-unpacking download) clear themselves on a later poll, so
   * the entry is retried until MAX_IMPORT_ATTEMPTS, then parked as `failed` so it stops
   * being retried forever and becomes visible for manual intervention.
   */
  private async recordImportFailure(
    entry: QueueEntryRow,
    err: Error,
  ): Promise<void> {
    const data = (entry.data ?? {}) as Record<string, unknown>;
    const attempts = Number(data.importAttempts ?? 0) + 1;
    const exhausted = attempts >= MAX_IMPORT_ATTEMPTS;
    const now = new Date().toISOString();

    await this.db.update(schema.downloadQueueEntry)
      .set({
        status: exhausted ? "failed" : entry.status,
        errorMessage: err.message,
        data: { ...data, importAttempts: attempts, lastImportError: err.message },
        updatedAt: now,
      })
      .where(eq(schema.downloadQueueEntry.id, entry.id));

    this.logger.warn(
      `import failed for "${entry.title}" (attempt ${attempts}/${MAX_IMPORT_ATTEMPTS}${exhausted ? ", giving up" : ""}): ${err.message}`,
    );

    if (exhausted) {
      await this.db.insert(schema.historyEntry).values({
        id: newEntityId("hist"),
        mediaType: entry.mediaType,
        mediaId: entry.mediaId,
        action: "import_failed",
        data: { title: entry.title, downloadId: entry.downloadId, error: err.message, attempts },
        createdAt: now,
      });
      // Release-level failure (we downloaded it and it wasn't usable N times running) —
      // blocklist it so RSS sync and manual grab both stop offering it again. Deliberately
      // NOT done for client/indexer-outage failures (DownloadClientFailed/IndexerFailed) —
      // those mean "try again later," not "never again."
      await this.blocklist.add({
        mediaType: entry.mediaType as "movie" | "series",
        mediaId: entry.mediaId,
        title: entry.title,
        indexerId: (data as { indexerId?: string }).indexerId ?? null,
        reason: `import failed after ${attempts} attempts: ${err.message}`,
      });
      this.events.publish(
        EventTypes.ImportFailed,
        { mediaType: entry.mediaType, mediaId: entry.mediaId, title: entry.title, downloadId: entry.downloadId, error: err.message },
        { aggType: entry.mediaType as never, aggId: entry.mediaId },
      );
    }
  }

  private async findEntry(downloadClientId: string | null, downloadId: string) {
    const cond = downloadClientId
      ? and(eq(schema.downloadQueueEntry.downloadClientId, downloadClientId), eq(schema.downloadQueueEntry.downloadId, downloadId))
      : and(isNull(schema.downloadQueueEntry.downloadClientId), eq(schema.downloadQueueEntry.downloadId, downloadId));
    const rows = await this.db.select().from(schema.downloadQueueEntry).where(cond).limit(1);
    return rows[0] ?? null;
  }

  /** Import a completed download into the library (movies: single file; series: every
   *  video file the download contains, decided and applied independently). */
  async importCompletedEntry(
    entry: QueueEntryRow,
    item: ClientQueueItem,
    _provider?: DownloadClientContract,
  ): Promise<ImportResult> {
    const cfg = await this.config.get();
    const downloadsRoot = cfg["paths.downloads"] || resolve(process.cwd(), "data", "downloads");
    const content = await this.resolveContent(item, entry, downloadsRoot);
    if (!content) {
      throw new Error(`No video file found for "${entry.title}" under ${downloadsRoot}`);
    }

    if (entry.mediaType === "movie") return this.importMovie(entry, content, cfg, item);
    return this.importSeries(entry, content, cfg, item);
  }

  private async importMovie(
    entry: QueueEntryRow,
    content: ResolvedContent,
    cfg: RuntimeSettings,
    item: ClientQueueItem,
  ): Promise<ImportResult> {
    const movie = await this.db.select().from(schema.movie).where(eq(schema.movie.id, entry.mediaId)).limit(1);
    if (!movie[0]) throw ApiError.notFound("movie", entry.mediaId);

    const source = content.kind === "file" ? content : await findLargestVideo(this.storage, content.path);
    if (!source) throw new Error(`No video file found for "${entry.title}" under ${content.path}`);

    const root = this.resolveRoot(cfg, movie[0].rootFolderPath, resolve(process.cwd(), "data", "media", "movies"));
    const folderName = movieFolderName(movie[0].title, movie[0].releaseDate);
    const targetDir = join(root, folderName);
    await this.storage.ensureDir(targetDir);
    const targetFile = join(targetDir, `${folderName}${extname(source.path)}`);
    const hardlinked = await this.storage.hardlink(source.path, targetFile);
    if (!existsSync(targetFile)) await this.storage.copy(source.path, targetFile);
    const size = statSync(targetFile).size;

    const now = new Date().toISOString();
    const mediaFileId = newEntityId("mf");
    const quality = spQuality(entry);

    await this.db.insert(schema.mediaFile).values({
      id: mediaFileId, mediaType: "movie", mediaId: movie[0].id, episodeIds: [],
      relativePath: relative(root, targetFile), size, quality, dateAdded: now,
    });
    await this.db.update(schema.movie).set({ hasFile: true, updatedAt: now }).where(eq(schema.movie.id, movie[0].id));
    await this.markAvailability("movie", movie[0].id, now);
    await this.insertHistory("movie", movie[0].id, now, { title: entry.title, downloadId: item.downloadId, path: targetFile, size, mediaFileId, hardlinked });
    await this.markEntryImported(entry, now);
    this.emitImport("movie", movie[0].id, movie[0].title, item.downloadId, targetFile, mediaFileId);
    return { imported: [{ mediaFileId, path: targetFile, size, hardlinked, episodeIds: [] }], rejected: [] };
  }

  private async importSeries(
    entry: QueueEntryRow,
    content: ResolvedContent,
    cfg: RuntimeSettings,
    item: ClientQueueItem,
  ): Promise<ImportResult> {
    const series = await this.db.select().from(schema.series).where(eq(schema.series.id, entry.mediaId)).limit(1);
    if (!series[0]) throw ApiError.notFound("series", entry.mediaId);

    const releaseTitle = (entry.data as { releaseTitle?: string })?.releaseTitle ?? entry.title;
    const match = parseEpisodeRelease(releaseTitle);
    const root = this.resolveRoot(cfg, series[0].rootFolderPath, resolve(process.cwd(), "data", "media", "tv"));
    const safeSeries = seriesFolderName(series[0].title);
    const releaseQuality = spQuality(entry);
    const now = new Date().toISOString();

    const candidates = content.kind === "file"
      ? [{ path: content.path, size: content.size }]
      : await findAllVideos(this.storage, content.path);
    if (candidates.length === 0) {
      throw new Error(`No video file found for "${entry.title}" under ${content.path}`);
    }

    if (match.season === undefined) {
      // Unparseable release: no season to file under or episodes to match. Import the
      // single largest candidate as before, with no episode marked as having a file.
      return this.importSeriesUnknownSeason(entry, series[0], candidates[0], root, safeSeries, releaseQuality, item, now);
    }

    const seasonEpisodes = await this.media.episodesInSeason(series[0].id, match.season);
    const epNumberById = new Map(seasonEpisodes.map((e) => [e.id, e.episodeNumber]));
    const target = episodeTarget(series[0].id, match.season, seasonEpisodes, match.isSeasonPack);
    const existing = await this.media.existingFiles(target);
    const bestExistingByEpisode = new Map<string, { quality: Quality }>();
    for (const f of existing) {
      for (const epId of f.episodeIds) {
        const cur = bestExistingByEpisode.get(epId);
        if (!cur || compareQuality(f.quality, cur.quality) > 0) bestExistingByEpisode.set(epId, { quality: f.quality });
      }
    }
    const knownEpisodes = new Map<number, KnownEpisode>(
      seasonEpisodes.map((e) => [e.episodeNumber, { id: e.id, existingQuality: bestExistingByEpisode.get(e.id)?.quality ?? null }]),
    );
    const profile = await getQualityProfile(this.db, series[0].qualityProfileId);

    const targetDir = join(root, safeSeries, `Season ${match.season}`);
    await this.storage.ensureDir(targetDir);

    // Single-file, non-pack releases already know their episode(s) from the release title
    // itself — reuse that rather than re-parsing a possibly-uninformative filename. A
    // season pack's individual files each need their own filename parsed.
    const useReleaseLevelMatch = !match.isSeasonPack && match.episodes.length > 0 && candidates.length === 1;

    const imported: ImportedFile[] = [];
    const rejected: RejectedFile[] = [];
    let fileIndex = 0;

    for (const file of candidates) {
      const episodesInFile = useReleaseLevelMatch ? match.episodes : parseEpisodeRelease(baseNameOf(file.path)).episodes;
      const decision = decideImportFile(file, episodesInFile, knownEpisodes, releaseQuality, profile);
      if (!decision.approved) {
        rejected.push({ path: file.path, reasons: decision.rejections.map(rejectionLabel) });
        continue;
      }
      try {
        const applied = await this.applySeriesFile(
          series[0].id, file, decision.episodeIds, epNumberById, targetDir, root, match.season, safeSeries, releaseQuality, now, fileIndex++,
        );
        imported.push(applied);
      } catch (err) {
        rejected.push({ path: file.path, reasons: [`apply_failed: ${(err as Error).message}`] });
      }
    }

    if (imported.length === 0) {
      throw new Error(
        `No importable file for "${entry.title}" — ${rejected.length} file(s) rejected: ${rejected.map((r) => `${r.path} (${r.reasons.join(", ")})`).join("; ")}`,
      );
    }

    // Upgrade-replace: an old file is only removed once every episode it covered has a
    // newly-imported file — an old multi-episode file where only some episodes were
    // superseded this round is left alone rather than partially invalidated. No recycle
    // bin (gap report B7, file organiser, still open) — the superseded file is deleted
    // outright, not moved aside.
    const newlyCovered = new Set(imported.flatMap((f) => f.episodeIds));
    for (const f of existing) {
      if (f.episodeIds.length > 0 && f.episodeIds.every((id) => newlyCovered.has(id))) {
        await this.db.delete(schema.mediaFile).where(eq(schema.mediaFile.id, f.id));
        await this.storage.delete(join(root, f.relativePath)).catch(() => {});
      }
    }

    await this.markAvailability("series", series[0].id, now);
    await this.insertHistory("series", series[0].id, now, {
      title: releaseTitle, downloadId: item.downloadId, season: match.season,
      imported: imported.map((f) => ({ mediaFileId: f.mediaFileId, path: f.path, episodes: f.episodeIds.map((id) => epNumberById.get(id)) })),
      rejected,
    });
    await this.markEntryImported(entry, now);
    const first = imported[0];
    this.emitImport("series", series[0].id, series[0].title, item.downloadId, first.path, first.mediaFileId, {
      season: match.season, filesImported: imported.length, filesRejected: rejected.length,
      episodes: imported.flatMap((f) => f.episodeIds),
    });
    return { imported, rejected };
  }

  /** Hardlink/copy one approved series file into place, write its media_file row, and
   *  mark every episode it covers as having a file. */
  private async applySeriesFile(
    seriesId: string,
    file: { path: string; size: number },
    episodeIds: string[],
    epNumberById: Map<string, number>,
    targetDir: string,
    root: string,
    season: number,
    safeSeries: string,
    quality: Quality,
    now: string,
    fileIndex: number,
  ): Promise<ImportedFile> {
    const baseName = episodeIds.length > 0
      ? `${safeSeries} - ${episodeIds.map((id) => episodeQueryTag(season, epNumberById.get(id) ?? 0)).join("-")}`
      // Unmatched file inside a pack (couldn't tell which episode it is) — disambiguate
      // with the original filename rather than colliding with siblings on a shared name.
      : `${safeSeries} - S${pad2(season)} - ${fileIndex}-${baseNameOf(file.path).replace(extname(file.path), "")}`;
    const targetFile = join(targetDir, `${baseName}${extname(file.path)}`);
    const hardlinked = await this.storage.hardlink(file.path, targetFile);
    if (!existsSync(targetFile)) await this.storage.copy(file.path, targetFile);
    const size = statSync(targetFile).size;

    const mediaFileId = newEntityId("mf");
    await this.db.insert(schema.mediaFile).values({
      id: mediaFileId, mediaType: "series", mediaId: seriesId, episodeIds,
      relativePath: relative(root, targetFile), size, quality, dateAdded: now,
    });
    for (const epId of episodeIds) {
      await this.db.update(schema.episode).set({ hasFile: true }).where(eq(schema.episode.id, epId));
    }
    return { mediaFileId, path: targetFile, size, hardlinked, episodeIds };
  }

  /** Release didn't parse to a season at all — file it under "Season Unknown" with no
   *  episode matched, same fallback behaviour as before P0.5. */
  private async importSeriesUnknownSeason(
    entry: QueueEntryRow,
    series: typeof schema.series.$inferSelect,
    source: { path: string; size: number },
    root: string,
    safeSeries: string,
    quality: Quality,
    item: ClientQueueItem,
    now: string,
  ): Promise<ImportResult> {
    const targetDir = join(root, safeSeries, "Season Unknown");
    await this.storage.ensureDir(targetDir);
    const targetFile = join(targetDir, `${safeSeries}${extname(source.path)}`);
    const hardlinked = await this.storage.hardlink(source.path, targetFile);
    if (!existsSync(targetFile)) await this.storage.copy(source.path, targetFile);
    const size = statSync(targetFile).size;

    const mediaFileId = newEntityId("mf");
    await this.db.insert(schema.mediaFile).values({
      id: mediaFileId, mediaType: "series", mediaId: series.id, episodeIds: [],
      relativePath: relative(root, targetFile), size, quality, dateAdded: now,
    });
    await this.markAvailability("series", series.id, now);
    await this.insertHistory("series", series.id, now, {
      title: entry.title, downloadId: item.downloadId, path: targetFile, size, mediaFileId, hardlinked, episodeMatched: false,
    });
    await this.markEntryImported(entry, now);
    this.emitImport("series", series.id, series.title, item.downloadId, targetFile, mediaFileId);
    return { imported: [{ mediaFileId, path: targetFile, size, hardlinked, episodeIds: [] }], rejected: [] };
  }

  /**
   * Update the availability row for a title.
   *
   * This previously matched on mediaId alone with no upsert and swallowed every error, so
   * when the row was missing — which happened for any series added before the availability
   * insert was made reliable, and for anything created by the upstream importer — the
   * update matched nothing and availability stayed "unknown" forever, silently.
   */
  private async markAvailability(mediaType: "movie" | "series", mediaId: string, now: string): Promise<void> {
    const status = mediaType === "movie" ? "available" : await this.seriesAvailability(mediaId);
    await ensureAvailability(this.db, mediaType, mediaId);
    await this.db.update(schema.mediaAvailability)
      .set({ status, lastAvailabilitySyncAt: now })
      .where(and(
        eq(schema.mediaAvailability.mediaType, mediaType),
        eq(schema.mediaAvailability.mediaId, mediaId),
      ));
  }

  /** A series is fully available only once no monitored episode is still missing. */
  private async seriesAvailability(seriesId: string): Promise<"available" | "partially_available"> {
    const missing = await this.db.select({ n: count() }).from(schema.episode)
      .where(and(
        eq(schema.episode.seriesId, seriesId),
        eq(schema.episode.monitored, true),
        eq(schema.episode.hasFile, false),
      ));
    return Number(missing[0]?.n ?? 0) === 0 ? "available" : "partially_available";
  }

  private async insertHistory(mediaType: string, mediaId: string, now: string, data: Record<string, unknown>): Promise<void> {
    await this.db.insert(schema.historyEntry).values({
      id: newEntityId("hist"), mediaType, mediaId, action: "import_completed", data, createdAt: now,
    });
  }

  /**
   * Close out a queue entry after a successful import.
   *
   * The download is deliberately LEFT IN THE CLIENT. Torrents need to keep seeding to meet
   * tracker ratio requirements, and the imported library file is typically a hardlink to
   * the client's data, so pulling the download also risks the payload. Reaping completed
   * downloads belongs to a seed-goal policy (roadmap P2), not to import. The `imported`
   * status is terminal, so the monitor will not touch this entry again.
   */
  private async markEntryImported(
    entry: QueueEntryRow,
    now: string,
  ): Promise<void> {
    await this.db.update(schema.downloadQueueEntry)
      .set({ status: "imported", progress: 100, errorMessage: null, updatedAt: now })
      .where(eq(schema.downloadQueueEntry.id, entry.id));
  }

  private emitImport(
    mediaType: string, mediaId: string, title: string, downloadId: string, path: string, mediaFileId: string,
    extra: Record<string, unknown> = {},
  ): void {
    this.events.publish(
      EventTypes.ImportCompleted,
      { mediaType, mediaId, title, downloadId, path, mediaFileId, ...extra },
      { aggType: mediaType as never, aggId: mediaId },
    );
    this.logger.log(`imported "${title}" -> ${path}`);
  }

  /** Locate the completed download's content — a direct file, or a directory to enumerate
   *  (movies want the largest video inside it; series want every video inside it). */
  private async resolveContent(item: ClientQueueItem, entry: QueueEntryRow, downloadsRoot: string): Promise<ResolvedContent | null> {
    // explicit content path from the client (qbittorrent: content_path / save_path)
    if (item.contentPath) {
      if (isVideo(item.contentPath)) return { kind: "file", path: item.contentPath, size: statSyncSafe(item.contentPath) };
      if (existsSync(item.contentPath)) return { kind: "dir", path: item.contentPath };
    }
    // explicit completed path recorded at grab time (memory/demo)
    const data = (entry.data ?? {}) as { completedPath?: string };
    if (data.completedPath) {
      if (isVideo(data.completedPath)) return { kind: "file", path: data.completedPath, size: statSyncSafe(data.completedPath) };
      if (existsSync(data.completedPath)) return { kind: "dir", path: data.completedPath };
    }
    // conventional usenet layouts under the downloads root
    const title = sanitizeEntry(entry.title);
    const cat = (entry.data as { category?: string })?.category ?? "movies";
    const candidates = [
      join(downloadsRoot, title),
      join(downloadsRoot, "complete", title),
      join(downloadsRoot, cat, title),
      join(downloadsRoot, "complete"),
    ];
    for (const dir of candidates) {
      if (existsSync(dir) && statSync(dir).isDirectory()) return { kind: "dir", path: dir };
    }
    return null;
  }

  private resolveRoot(cfg: RuntimeSettings, mediaRoot: string, fallback: string): string {
    const configured = cfg["paths.rootFolders"]?.[0]?.path;
    return mediaRoot || configured || fallback;
  }
}

function sanitizeEntry(title: string): string {
  return title.replace(/[^A-Za-z0-9 _()[\]-]/g, "").trim() || "download";
}

function isVideo(path: string): boolean {
  return [".mkv", ".mp4", ".avi", ".mov", ".m4v", ".ts", ".wmv", ".webm", ".flv", ".mpg", ".mpeg"].includes(extname(path).toLowerCase());
}

function statSyncSafe(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

function baseNameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function rejectionLabel(r: ImportRejection): string {
  return r.reason;
}

function spQuality(entry: { data: Record<string, unknown> }): Quality {
  const q = entry.data?.quality as Partial<Quality> | undefined;
  return q ? { source: q.source ?? "unknown", resolution: q.resolution ?? "unknown", edition: q.edition ?? "" }
           : { source: "unknown", resolution: "unknown", edition: "" };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
