// SPDX-License-Identifier: MIT
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
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
import { LocalStorageProvider, findLargestVideo } from "@medianexus/integrations";
import type { ClientQueueItem, DownloadClientContract } from "@medianexus/integrations";
import { parseEpisodeRelease, episodeQueryTag } from "@medianexus/domain";

/**
 * Acquisition: drives download clients, mirrors their queues into download_queue_entry,
 * monitors progress and performs the filesystem import when a download completes.
 * Real import path (M1): find the completed video file under the downloads root,
 * hardlink/copy it into the library root with the naming template, then mark the
 * movie available. Deeper heuristics (per-downloader layouts, series episodes) land in M2.
 */
@Injectable()
export class AcquisitionService {
  private readonly logger = new Logger(AcquisitionService.name);
  private readonly storage = new LocalStorageProvider();

  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly config: ConfigService,
    private readonly events: EventsService,
    private readonly providers: ProvidersService,
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
      if (item.status === "completed") {
        await this.importCompletedEntry(entry, item, client.provider);
        imported++;
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

  private async findEntry(downloadClientId: string | null, downloadId: string) {
    const cond = downloadClientId
      ? and(eq(schema.downloadQueueEntry.downloadClientId, downloadClientId), eq(schema.downloadQueueEntry.downloadId, downloadId))
      : and(isNull(schema.downloadQueueEntry.downloadClientId), eq(schema.downloadQueueEntry.downloadId, downloadId));
    const rows = await this.db.select().from(schema.downloadQueueEntry).where(cond).limit(1);
    return rows[0] ?? null;
  }

  /** Import a completed download into the library (movies: single file; series: episode-mapped). */
  async importCompletedEntry(
    entry: (typeof schema.downloadQueueEntry.$inferSelect),
    item: ClientQueueItem,
    provider: DownloadClientContract,
  ): Promise<{ mediaFileId: string; path: string; size: number; hardlinked: boolean; episodes?: string[] }> {
    const cfg = await this.config.get();
    const downloadsRoot = cfg["paths.downloads"] || resolve(process.cwd(), "data", "downloads");
    const source = await this.resolveSource(item, entry, downloadsRoot);
    if (!source) {
      throw new Error(`No video file found for "${entry.title}" under ${downloadsRoot}`);
    }

    if (entry.mediaType === "movie") return this.importMovie(entry, source, cfg, item, provider);
    return this.importSeries(entry, source, cfg, provider, item);
  }

  private async importMovie(
    entry: (typeof schema.downloadQueueEntry.$inferSelect),
    source: { path: string; size: number },
    cfg: RuntimeSettings,
    item: ClientQueueItem,
    provider: DownloadClientContract,
  ): Promise<{ mediaFileId: string; path: string; size: number; hardlinked: boolean }> {
    const movie = await this.db.select().from(schema.movie).where(eq(schema.movie.id, entry.mediaId)).limit(1);
    if (!movie[0]) throw ApiError.notFound("movie", entry.mediaId);

    const root = movie[0].rootFolderPath || cfg["paths.rootFolders"]?.[0]?.path || resolve(process.cwd(), "data", "media", "movies");
    const parsed = parseTitleForFolder(movie[0].title, movie[0].releaseDate ?? undefined);
    const targetDir = join(root, `${parsed.title} (${parsed.year})`);
    await this.storage.ensureDir(targetDir);
    const targetFile = join(targetDir, `${parsed.title} (${parsed.year})${extname(source.path)}`);
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
    await this.removeQueueEntry(entry, item, provider, now);
    this.emitImport("movie", movie[0].id, movie[0].title, item.downloadId, targetFile, mediaFileId);
    return { mediaFileId, path: targetFile, size, hardlinked };
  }

  private async importSeries(
    entry: (typeof schema.downloadQueueEntry.$inferSelect),
    source: { path: string; size: number },
    cfg: RuntimeSettings,
    provider: DownloadClientContract,
    item: ClientQueueItem,
  ): Promise<{ mediaFileId: string; path: string; size: number; hardlinked: boolean; episodes: string[] }> {
    const series = await this.db.select().from(schema.series).where(eq(schema.series.id, entry.mediaId)).limit(1);
    if (!series[0]) throw ApiError.notFound("series", entry.mediaId);

    const releaseTitle = (entry.data as { releaseTitle?: string })?.releaseTitle ?? entry.title;
    const match = parseEpisodeRelease(releaseTitle);
    const root = series[0].rootFolderPath || cfg["paths.rootFolders"]?.[0]?.path || resolve(process.cwd(), "data", "media", "tv");
    const safeSeries = series[0].title.replace(/[^A-Za-z0-9 _()[\]-]/g, "").trim() || "Series";

    let episodeIds: string[] = [];
    let targetDir: string;
    let baseName: string;

    if (match.season !== undefined && match.episodes.length > 0) {
      // resolve matching episode rows (any existing episode with those numbers)
      const rows = await this.db.select().from(schema.episode).where(and(
        eq(schema.episode.seriesId, series[0].id),
        inArray(sql`${schema.episode.episodeNumber}`, match.episodes),
      ));
      episodeIds = rows
        .filter((r) => r.monitored || !episodeIds.length || true)
        .map((r) => r.id);
      // season folder from matched season number
      targetDir = join(root, safeSeries, `Season ${match.season}`);
      const tag = episodeQueryTag(match.season, match.episodes[0]) + (match.episodes.length > 1 ? `-E${pad2(match.episodes[match.episodes.length - 1])}` : "");
      baseName = `${safeSeries} - ${tag}`;
    } else {
      targetDir = join(root, safeSeries, "Season Unknown");
      baseName = safeSeries;
    }

    await this.storage.ensureDir(targetDir);
    const targetFile = join(targetDir, `${baseName}${extname(source.path)}`);
    const hardlinked = await this.storage.hardlink(source.path, targetFile);
    if (!existsSync(targetFile)) await this.storage.copy(source.path, targetFile);
    const size = statSync(targetFile).size;

    const now = new Date().toISOString();
    const mediaFileId = newEntityId("mf");
    await this.db.insert(schema.mediaFile).values({
      id: mediaFileId, mediaType: "series", mediaId: series[0].id, episodeIds,
      relativePath: relative(root, targetFile), size, quality: spQuality(entry), dateAdded: now,
    });

    const updatedEps: string[] = [];
    for (const epId of episodeIds) {
      await this.db.update(schema.episode).set({ hasFile: true }).where(eq(schema.episode.id, epId));
      updatedEps.push(epId);
    }
    await this.markAvailability("series", series[0].id, now);
    await this.insertHistory("series", series[0].id, now, {
      title: releaseTitle, downloadId: item.downloadId, path: targetFile, size, mediaFileId, hardlinked,
      episodeMatched: episodeIds.length > 0, episodes: match.episodes, season: match.season,
    });
    await this.removeQueueEntry(entry, item, provider, now);
    this.emitImport("series", series[0].id, series[0].title, item.downloadId, targetFile, mediaFileId, { episodes: match.episodes, season: match.season });
    return { mediaFileId, path: targetFile, size, hardlinked, episodes: updatedEps };
  }

  private async markAvailability(mediaType: "movie" | "series", mediaId: string, now: string): Promise<void> {
    if (mediaType === "movie") {
      await this.db.update(schema.mediaAvailability)
        .set({ status: "available", lastAvailabilitySyncAt: now })
        .where(eq(schema.mediaAvailability.mediaId, mediaId)).catch(() => {});
      return;
    }
    const missing = await this.db.select({ n: count() }).from(schema.episode)
      .where(and(eq(schema.episode.seriesId, mediaId), eq(schema.episode.monitored, true), eq(schema.episode.hasFile, false)));
    const status = Number(missing[0]?.n ?? 0) === 0 ? "available" : "partially_available";
    await this.db.update(schema.mediaAvailability)
      .set({ status, lastAvailabilitySyncAt: now })
      .where(eq(schema.mediaAvailability.mediaId, mediaId)).catch(() => {});
  }

  private async insertHistory(mediaType: string, mediaId: string, now: string, data: Record<string, unknown>): Promise<void> {
    await this.db.insert(schema.historyEntry).values({
      id: newEntityId("hist"), mediaType, mediaId, action: "import_completed", data, createdAt: now,
    });
  }

  private async removeQueueEntry(
    entry: (typeof schema.downloadQueueEntry.$inferSelect),
    item: ClientQueueItem,
    provider: DownloadClientContract,
    now: string,
  ): Promise<void> {
    await this.db.update(schema.downloadQueueEntry).set({ status: "imported", progress: 100, updatedAt: now }).where(eq(schema.downloadQueueEntry.id, entry.id));
    await provider.remove(item.downloadId).catch(() => {});
  }

  private emitImport(
    mediaType: string, mediaId: string, title: string, downloadId: string, path: string, mediaFileId: string,
    extra: Record<string, unknown> = {},
  ): void {
    this.events.publish(
      EventTypes.ImportCompleted,
      { mediaId, title, downloadId, path, mediaFileId, ...extra },
      { aggType: mediaType as never, aggId: mediaId },
    );
    this.logger.log(`imported "${title}" -> ${path}`);
  }

  /** Locate the completed video file for an item across known layouts. */
  private async resolveSource(item: ClientQueueItem, entry: (typeof schema.downloadQueueEntry.$inferSelect), downloadsRoot: string): Promise<{ path: string; size: number } | null> {
    const candidates: string[] = [];

    // explicit content path from the client (qbittorrent: content_path / save_path)
    if (item.contentPath) {
      if (isVideo(item.contentPath)) return { path: item.contentPath, size: statSyncSafe(item.contentPath) };
      const f = await findLargestVideo(this.storage, item.contentPath).catch(() => null);
      if (f) return f;
    }
    // explicit completed path recorded at grab time (memory/demo)
    const data = (entry.data ?? {}) as { completedPath?: string };
    if (data.completedPath) {
      if (isVideo(data.completedPath)) return { path: data.completedPath, size: statSyncSafe(data.completedPath) };
      const f = await findLargestVideo(this.storage, data.completedPath).catch(() => null);
      if (f) return f;
    }
    // conventional usenet layouts under the downloads root
    const title = sanitizeEntry(entry.title);
    const cat = (entry.data as { category?: string })?.category ?? "movies";
    candidates.push(join(downloadsRoot, title));
    candidates.push(join(downloadsRoot, "complete", title));
    candidates.push(join(downloadsRoot, cat, title));
    candidates.push(join(downloadsRoot, "complete"));
    for (const dir of candidates) {
      if (existsSync(dir) && statSync(dir).isDirectory()) {
        const found = await findLargestVideo(this.storage, dir).catch(() => null);
        if (found) return found;
      }
    }
    return null;
  }

  private resolveRoot(cfg: RuntimeSettings, movieRoot: string, _downloadsRoot: string): string {
    const configured = cfg["paths.rootFolders"]?.[0]?.path;
    return movieRoot || configured || resolve(process.cwd(), "data", "media", "movies");
  }
}

function parseTitleForFolder(title: string, releaseDate?: string): { title: string; year: string } {
  const safe = title.replace(/[^A-Za-z0-9 _()[\]-]/g, "").trim();
  return { title: safe, year: releaseDate ? releaseDate.slice(0, 4) : "Unknown" };
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

function spQuality(entry: { data: Record<string, unknown> }): { source: string; resolution: string; edition: string } {
  const q = entry.data?.quality as { source?: string; resolution?: string; edition?: string } | undefined;
  return q ? { source: q.source ?? "unknown", resolution: q.resolution ?? "unknown", edition: q.edition ?? "" }
           : { source: "unknown", resolution: "unknown", edition: "" };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
