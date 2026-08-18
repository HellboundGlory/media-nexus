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
import { ProviderStatusService } from "../providers/provider-status.service";
import { LocalStorageProvider, findLargestVideo, findAllVideos } from "@medianexus/integrations";
import type { ClientQueueItem, DownloadClientContract } from "@medianexus/integrations";
import {
  parseEpisodeRelease, episodeTarget, compareQuality,
  decideImportFile, type KnownEpisode, type ImportRejection, type Quality, type SeriesType,
} from "@medianexus/domain";
import { MediaRepository } from "../media/media.repository";
import { ensureAvailabilitySync, ensureAvailabilityTx, getQualityProfile, type Tx } from "../media/library.helpers";
import { movieFileName, episodeFileName, resolvedMovieFolderName, resolvedSeriesFolderName } from "../media/naming.helpers";
import { BlocklistService } from "../blocklist/blocklist.service";
import { RootFoldersService } from "../root-folders/root-folders.service";
import { RemotePathMappingsService } from "../remote-path-mappings/remote-path-mappings.service";
import { RecycleBinService } from "../media/recycle-bin.service";

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
export const TERMINAL_QUEUE_STATUSES = new Set(["imported", "removed", "failed", "download_failed"]);

/** How many times an import may fail before the queue entry is parked as failed. */
const MAX_IMPORT_ATTEMPTS = 3;

/** A single "failed"/missing poll can be transient (a client mid-retry, a snapshot glitch),
 *  so both the download-failure and removed-from-client paths require this many consecutive
 *  polls reporting the same thing before committing — see applyLiveStatus/
 *  reconcileMissingEntries (roadmap B5, gap report). */
const CONSECUTIVE_POLLS_BEFORE_COMMIT = 2;

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
    private readonly rootFolders: RootFoldersService,
    private readonly remotePathMappings: RemotePathMappingsService,
    private readonly recycleBin: RecycleBinService,
    private readonly status: ProviderStatusService,
  ) {}

  /** Poll every configured download client and import anything completed. A client that
   *  is backed off / auto-disabled (B10) is skipped here, so a dead client's getQueue() is
   *  not retried on every 15s tick; a successful sync clears its failure state. */
  async syncAll(): Promise<{ clients: number; imported: number; updated: number }> {
    const clients = await this.providers.configuredDownloadClients();
    let imported = 0;
    let updated = 0;
    for (const client of clients) {
      const clientId = client.row?.id ?? null;
      const gate = await this.status.beforeCall("downloadClient", clientId, "query");
      if (gate.skip) continue;
      try {
        const r = await this.syncForClient(client);
        await this.status.recordSuccess("downloadClient", clientId);
        imported += r.imported;
        updated += r.updated;
        // Seed-goal policy (D3): reap torrents that have met their ratio/seed-time goal.
        await this.seedGoalSweep(client);
      } catch (err) {
        await this.status.recordFailure("downloadClient", clientId, err);
        this.logger.warn(`client sync failed (${client.row?.id ?? "memory"}): ${(err as Error).message}`);
        this.events.publish(EventTypes.DownloadClientFailed, { clientId: client.row?.id ?? null, error: (err as Error).message });
      }
    }
    return { clients: clients.length, imported, updated };
  }

  async syncForClient(client: ConfiguredClient): Promise<{ imported: number; updated: number }> {
    const clientId = client.row?.id ?? null;
    const items = await client.provider.getQueue();
    const cfg = await this.config.get();
    const presentIds = new Set<string>();
    let imported = 0;
    let updated = 0;
    for (const item of items) {
      presentIds.add(item.downloadId);
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
          await this.applyRemoveOnImport(client, item);
        } catch (err) {
          await this.recordImportFailure(entry, err as Error);
        }
      } else {
        await this.applyLiveStatus(entry, item, cfg, client.provider);
        updated++;
      }
    }
    // Entries the client's own snapshot no longer mentions (cancelled/purged externally) —
    // the loop above never visits these, since it only iterates what the client reported.
    await this.reconcileMissingEntries(clientId, presentIds);
    return { imported, updated };
  }

  /**
   * Apply one poll's worth of live status for a non-completed, non-terminal entry:
   * debounced download-failure detection, then stall detection/recovery, then a plain
   * field copy for the ordinary case. Never called for `item.status === "completed"` —
   * that path is `importCompletedEntry`/`recordImportFailure`.
   */
  private async applyLiveStatus(
    entry: QueueEntryRow,
    item: ClientQueueItem,
    cfg: RuntimeSettings,
    provider: DownloadClientContract,
  ): Promise<void> {
    const data = (entry.data ?? {}) as Record<string, unknown>;
    const now = new Date().toISOString();

    if (item.status === "failed") {
      // A single "error"/"failing" read from a client can be transient — require two
      // consecutive polls reporting failure before committing, since there's no recovery
      // path after recordDownloadFailure() runs (it blocklists and purges the download).
      const consecutiveFailures = Number(data.consecutiveFailures ?? 0) + 1;
      if (consecutiveFailures >= CONSECUTIVE_POLLS_BEFORE_COMMIT) {
        await this.recordDownloadFailure(
          entry, provider, `download reported failed: ${item.errorMessage ?? "unknown error"}`,
        );
        return;
      }
      await this.db.update(schema.downloadQueueEntry)
        .set({ errorMessage: item.errorMessage ?? null, data: { ...data, consecutiveFailures }, updatedAt: now })
        .where(eq(schema.downloadQueueEntry.id, entry.id));
      return;
    }

    await this.detectStall(entry, item, cfg, provider, data, now);
  }

  /**
   * Track progress across polls to notice a download stuck at the same percentage — a
   * client-reported status alone (`downloading`/`queued`/`paused`) never surfaces this.
   * `data.lastProgress`/`data.lastProgressAt` record the last time progress actually moved.
   * No movement for `media.downloadStallMinutes` flips the entry to `stalled` (still
   * active — see ACTIVE_QUEUE_STATUSES); renewed movement flips it back; no movement for a
   * second full window escalates to a download failure.
   */
  private async detectStall(
    entry: QueueEntryRow,
    item: ClientQueueItem,
    cfg: RuntimeSettings,
    provider: DownloadClientContract,
    data: Record<string, unknown>,
    now: string,
  ): Promise<void> {
    const lastProgress = data.lastProgress as number | undefined;
    const lastProgressAt = data.lastProgressAt as string | undefined;
    // No prior reading to compare against (first poll for this entry) counts as "moved" —
    // there is no basis yet to call it stalled.
    const progressMoved = lastProgress === undefined || item.progress !== lastProgress;

    const baseFields = {
      progress: item.progress,
      size: item.size || entry.size,
      remainingTime: item.remainingTimeSeconds ?? null,
      errorMessage: item.errorMessage ?? null,
      updatedAt: now,
    };

    if (progressMoved) {
      // Explicit recovery direction: a previously-stalled entry whose progress has resumed
      // goes back to `downloading`, not just forward escalation.
      const recovered = entry.status === "stalled";
      await this.db.update(schema.downloadQueueEntry)
        .set({
          ...baseFields,
          status: recovered ? "downloading" : entry.status,
          data: { ...data, consecutiveFailures: 0, lastProgress: item.progress, lastProgressAt: now },
        })
        .where(eq(schema.downloadQueueEntry.id, entry.id));
      return;
    }

    const stallMs = cfg["media.downloadStallMinutes"] * 60_000;
    const referenceAt = lastProgressAt ? new Date(lastProgressAt).getTime() : new Date(now).getTime();
    const elapsed = new Date(now).getTime() - referenceAt;

    if (entry.status === "stalled" && elapsed >= 2 * stallMs) {
      await this.recordDownloadFailure(
        entry, provider,
        `download stalled with no progress for over ${Math.round((2 * stallMs) / 60_000)} minutes`,
      );
      return;
    }

    const nextStatus = elapsed >= stallMs ? "stalled" : entry.status;
    await this.db.update(schema.downloadQueueEntry)
      .set({
        ...baseFields,
        status: nextStatus,
        data: { ...data, consecutiveFailures: 0, lastProgress: item.progress, lastProgressAt: lastProgressAt ?? now },
      })
      .where(eq(schema.downloadQueueEntry.id, entry.id));
  }

  /**
   * Commit a confirmed download-level failure: the client itself gave up, or a stalled
   * entry never recovered through a second full stall window. Mirrors
   * recordImportFailure()'s shape but with no retry budget — a download that has already
   * exhausted the client's own retries (or sat stalled for two full windows) gets
   * blocklisted immediately, not after N more attempts.
   */
  private async recordDownloadFailure(
    entry: QueueEntryRow,
    provider: DownloadClientContract,
    reason: string,
  ): Promise<void> {
    const data = (entry.data ?? {}) as Record<string, unknown>;
    const now = new Date().toISOString();

    if (this.db.dbDialect === "postgres") {
      // better-sqlite3's native tx wrapper needs a sync callback; node-postgres needs async
      // (P2 item 12 Stage 2) — two irreconcilable signatures, so Postgres gets its own body.
      await this.db.transaction(async (tx) => {
        await tx.update(schema.downloadQueueEntry)
          .set({ status: "download_failed", errorMessage: reason, data: { ...data, consecutiveFailures: 0 }, updatedAt: now })
          .where(eq(schema.downloadQueueEntry.id, entry.id));

        await tx.insert(schema.historyEntry).values({
          id: newEntityId("hist"),
          mediaType: entry.mediaType,
          mediaId: entry.mediaId,
          action: "download_failed",
          data: { title: entry.title, downloadId: entry.downloadId, error: reason },
          createdAt: now,
        });

        await this.blocklist.addSyncAsync(tx, {
          mediaType: entry.mediaType as "movie" | "series",
          mediaId: entry.mediaId,
          title: entry.title,
          indexerId: (data as { indexerId?: string }).indexerId ?? null,
          reason,
        });
      });
    } else {
      this.db.transaction((tx) => {
        tx.update(schema.downloadQueueEntry)
          .set({ status: "download_failed", errorMessage: reason, data: { ...data, consecutiveFailures: 0 }, updatedAt: now })
          .where(eq(schema.downloadQueueEntry.id, entry.id))
          .run();

        tx.insert(schema.historyEntry).values({
          id: newEntityId("hist"),
          mediaType: entry.mediaType,
          mediaId: entry.mediaId,
          action: "download_failed",
          data: { title: entry.title, downloadId: entry.downloadId, error: reason },
          createdAt: now,
        }).run();

        this.blocklist.addSync(tx, {
          mediaType: entry.mediaType as "movie" | "series",
          mediaId: entry.mediaId,
          title: entry.title,
          indexerId: (data as { indexerId?: string }).indexerId ?? null,
          reason,
        });
      });
    }

    this.logger.warn(`download failed for "${entry.title}": ${reason}`);

    // Best-effort: a permanently failed download has no seeding value, unlike the deliberate
    // "leave completed downloads in the client" policy for successful imports
    // (markEntryImportedSync) — purge it, and its data, from the client.
    if (entry.downloadId) {
      try {
        await provider.remove(entry.downloadId, true);
      } catch (err) {
        this.logger.warn(`failed to remove failed download "${entry.title}" from client: ${(err as Error).message}`);
      }
    }

    this.events.publish(
      EventTypes.DownloadFailed,
      { mediaType: entry.mediaType, mediaId: entry.mediaId, title: entry.title, downloadId: entry.downloadId, error: reason },
      { aggType: entry.mediaType as never, aggId: entry.mediaId },
    );
  }

  /**
   * An entry the client's snapshot no longer mentions was cancelled or purged externally —
   * without this, it would stay at its last-known status forever. Debounced the same way as
   * download failures (two consecutive misses), and deliberately NOT blocklisted: unlike a
   * confirmed failure, disappearing from the client is ambiguous — it could be a legitimate
   * manual removal in the client's own UI.
   */
  private async reconcileMissingEntries(clientId: string | null, presentIds: Set<string>): Promise<void> {
    const clientCond = clientId
      ? eq(schema.downloadQueueEntry.downloadClientId, clientId)
      : isNull(schema.downloadQueueEntry.downloadClientId);
    const rows = await this.db.select().from(schema.downloadQueueEntry).where(clientCond);
    const now = new Date().toISOString();

    for (const entry of rows) {
      if (TERMINAL_QUEUE_STATUSES.has(entry.status)) continue;
      const data = (entry.data ?? {}) as Record<string, unknown>;

      if (!entry.downloadId || presentIds.has(entry.downloadId)) {
        // Present again (or nothing to match against) — clear any missing-tracking so a
        // future disappearance starts its debounce window fresh.
        if (data.missingSince !== undefined) {
          const { missingSince: _drop, ...rest } = data;
          await this.db.update(schema.downloadQueueEntry)
            .set({ data: rest, updatedAt: now })
            .where(eq(schema.downloadQueueEntry.id, entry.id));
        }
        continue;
      }

      if (data.missingSince === undefined) {
        await this.db.update(schema.downloadQueueEntry)
          .set({ data: { ...data, missingSince: now }, updatedAt: now })
          .where(eq(schema.downloadQueueEntry.id, entry.id));
        continue;
      }

      if (this.db.dbDialect === "postgres") {
        // better-sqlite3's native tx wrapper needs a sync callback; node-postgres needs async
        // (P2 item 12 Stage 2) — two irreconcilable signatures, so Postgres gets its own body.
        await this.db.transaction(async (tx) => {
          const { missingSince: _drop, ...rest } = data;
          await tx.update(schema.downloadQueueEntry)
            .set({ status: "removed", data: rest, updatedAt: now })
            .where(eq(schema.downloadQueueEntry.id, entry.id));
          await tx.insert(schema.historyEntry).values({
            id: newEntityId("hist"),
            mediaType: entry.mediaType,
            mediaId: entry.mediaId,
            action: "removed",
            data: { title: entry.title, downloadId: entry.downloadId },
            createdAt: now,
          });
        });
      } else {
        this.db.transaction((tx) => {
          const { missingSince: _drop, ...rest } = data;
          tx.update(schema.downloadQueueEntry)
            .set({ status: "removed", data: rest, updatedAt: now })
            .where(eq(schema.downloadQueueEntry.id, entry.id))
            .run();
          tx.insert(schema.historyEntry).values({
            id: newEntityId("hist"),
            mediaType: entry.mediaType,
            mediaId: entry.mediaId,
            action: "removed",
            data: { title: entry.title, downloadId: entry.downloadId },
            createdAt: now,
          }).run();
        });
      }
    }
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

    if (this.db.dbDialect === "postgres") {
      // better-sqlite3's native tx wrapper needs a sync callback; node-postgres needs async
      // (P2 item 12 Stage 2) — two irreconcilable signatures, so Postgres gets its own body.
      await this.db.transaction(async (tx) => {
        await tx.update(schema.downloadQueueEntry)
          .set({
            status: exhausted ? "failed" : entry.status,
            errorMessage: err.message,
            data: { ...data, importAttempts: attempts, lastImportError: err.message },
            updatedAt: now,
          })
          .where(eq(schema.downloadQueueEntry.id, entry.id));

        if (exhausted) {
          await tx.insert(schema.historyEntry).values({
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
          await this.blocklist.addSyncAsync(tx, {
            mediaType: entry.mediaType as "movie" | "series",
            mediaId: entry.mediaId,
            title: entry.title,
            indexerId: (data as { indexerId?: string }).indexerId ?? null,
            reason: `import failed after ${attempts} attempts: ${err.message}`,
          });
        }
      });
    } else {
      this.db.transaction((tx) => {
        tx.update(schema.downloadQueueEntry)
          .set({
            status: exhausted ? "failed" : entry.status,
            errorMessage: err.message,
            data: { ...data, importAttempts: attempts, lastImportError: err.message },
            updatedAt: now,
          })
          .where(eq(schema.downloadQueueEntry.id, entry.id))
          .run();

        if (exhausted) {
          tx.insert(schema.historyEntry).values({
            id: newEntityId("hist"),
            mediaType: entry.mediaType,
            mediaId: entry.mediaId,
            action: "import_failed",
            data: { title: entry.title, downloadId: entry.downloadId, error: err.message, attempts },
            createdAt: now,
          }).run();
          // Release-level failure (we downloaded it and it wasn't usable N times running) —
          // blocklist it so RSS sync and manual grab both stop offering it again. Deliberately
          // NOT done for client/indexer-outage failures (DownloadClientFailed/IndexerFailed) —
          // those mean "try again later," not "never again."
          this.blocklist.addSync(tx, {
            mediaType: entry.mediaType as "movie" | "series",
            mediaId: entry.mediaId,
            title: entry.title,
            indexerId: (data as { indexerId?: string }).indexerId ?? null,
            reason: `import failed after ${attempts} attempts: ${err.message}`,
          });
        }
      });
    }

    this.logger.warn(
      `import failed for "${entry.title}" (attempt ${attempts}/${MAX_IMPORT_ATTEMPTS}${exhausted ? ", giving up" : ""}): ${err.message}`,
    );

    if (exhausted) {
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

  private async findQueueEntry(id: string): Promise<QueueEntryRow | null> {
    const rows = await this.db.select().from(schema.downloadQueueEntry).where(eq(schema.downloadQueueEntry.id, id)).limit(1);
    return rows[0] ?? null;
  }

  /** Re-attempt a failed/terminal queue entry's import (roadmap C4 — retry). Resets the
   *  import retry budget, re-arms the entry to a non-terminal status (so the download
   *  monitor keeps it in play instead of skipping it forever), then immediately attempts
   *  the import from the download's auto-resolved payload. Never blocklists — this is the
   *  user saying "try again", not "never again"; if the payload isn't present yet the entry
   *  is left re-armed for the monitor to import once the client reports it completed.
   */
  async retryQueueEntry(id: string): Promise<{ ok: boolean; message?: string }> {
    const entry = await this.findQueueEntry(id);
    if (!entry) throw ApiError.notFound("queue entry", id);
    if (entry.status === "imported") throw new ApiError({ code: "CONFLICT", message: "Entry is already imported — remove it first if you want to re-grab" });
    const data = (entry.data ?? {}) as Record<string, unknown>;
    const { importAttempts: _a, lastImportError: _e, ...rest } = data;
    await this.db.update(schema.downloadQueueEntry)
      .set({ status: "downloading", errorMessage: null, data: rest, updatedAt: new Date().toISOString() })
      .where(eq(schema.downloadQueueEntry.id, id));
    try {
      await this.importQueueEntry(id, {});
      return { ok: true };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  /** Manually import a queue entry, optionally pointing the app at an explicit file/folder
   *  when automatic matching picked wrong or guessed a different path (roadmap C4 —
   *  manual-import). Reuses the whole `decideImportFile`-based import pipeline through
   *  `importCompletedEntry`. */
  async manualImportQueueEntry(id: string, opts: { path?: string }): Promise<ImportResult> {
    const entry = await this.findQueueEntry(id);
    if (!entry) throw ApiError.notFound("queue entry", id);
    if (entry.status === "imported") throw new ApiError({ code: "CONFLICT", message: "Entry is already imported" });
    const item = syntheticCompletedItem(entry, opts.path);
    try {
      return await this.importCompletedEntry(entry, item);
    } catch (err) {
      throw new ApiError({ code: "UNPROCESSABLE", message: `Import failed for "${entry.title}": ${(err as Error).message}` });
    }
  }

  /** Run the import pipeline for a queue entry using a synthetic "completed" client item,
   *  optionally forcing the content path (drives manual-import's explicit-path mode via
   *  `resolveContent`, which honors `item.contentPath` first). */
  private async importQueueEntry(id: string, opts: { path?: string }): Promise<ImportResult> {
    const entry = await this.findQueueEntry(id);
    if (!entry) throw ApiError.notFound("queue entry", id);
    return this.importCompletedEntry(entry, syntheticCompletedItem(entry, opts.path));
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

    const root = await this.resolveRoot(movie[0].rootFolderPath, resolve(process.cwd(), "data", "media", "movies"), "movie");
    await this.assertSufficientFreeSpace(root, source.size, cfg);
    const quality = spQuality(entry);
    const folderName = resolvedMovieFolderName(movie[0]);
    const targetDir = join(root, folderName);
    await this.storage.ensureDir(targetDir);
    const fileName = movieFileName(cfg, movie[0].title, movie[0].releaseDate, quality);
    const targetFile = join(targetDir, `${fileName}${extname(source.path)}`);
    const hardlinked = await this.storage.hardlink(source.path, targetFile);
    if (!existsSync(targetFile)) await this.storage.copy(source.path, targetFile);
    const size = statSync(targetFile).size;

    const now = new Date().toISOString();
    const mediaFileId = newEntityId("mf");
    const relativePath = relative(root, targetFile);

    if (this.db.dbDialect === "postgres") {
      // better-sqlite3's native tx wrapper needs a sync callback; node-postgres needs async
      // (P2 item 12 Stage 2) — two irreconcilable signatures, so Postgres gets its own body.
      await this.db.transaction(async (tx) => {
        await tx.insert(schema.mediaFile).values({
          id: mediaFileId, mediaType: "movie", mediaId: movie[0].id,
          relativePath, size, quality, dateAdded: now,
        });
        await tx.update(schema.movie).set({ hasFile: true, updatedAt: now }).where(eq(schema.movie.id, movie[0].id));
        await this.markAvailability(tx, "movie", movie[0].id, now);
        await this.insertHistory(tx, "movie", movie[0].id, now, { title: entry.title, downloadId: item.downloadId, path: targetFile, size, mediaFileId, hardlinked });
        await this.markEntryImported(tx, entry, now);
      });
    } else {
      this.db.transaction((tx) => {
        tx.insert(schema.mediaFile).values({
          id: mediaFileId, mediaType: "movie", mediaId: movie[0].id,
          relativePath, size, quality, dateAdded: now,
        }).run();
        tx.update(schema.movie).set({ hasFile: true, updatedAt: now }).where(eq(schema.movie.id, movie[0].id)).run();
        this.markAvailabilitySync(tx, "movie", movie[0].id, now);
        this.insertHistorySync(tx, "movie", movie[0].id, now, { title: entry.title, downloadId: item.downloadId, path: targetFile, size, mediaFileId, hardlinked });
        this.markEntryImportedSync(tx, entry, now);
      });
    }
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
    const root = await this.resolveRoot(series[0].rootFolderPath, resolve(process.cwd(), "data", "media", "tv"), "series");
    const safeSeries = resolvedSeriesFolderName(series[0]);
    const releaseQuality = spQuality(entry);
    const now = new Date().toISOString();

    const candidates = content.kind === "file"
      ? [{ path: content.path, size: content.size }]
      : await findAllVideos(this.storage, content.path);
    if (candidates.length === 0) {
      throw new Error(`No video file found for "${entry.title}" under ${content.path}`);
    }
    await this.assertSufficientFreeSpace(root, candidates.reduce((sum, f) => sum + f.size, 0), cfg);

    const seriesType = series[0].seriesType as SeriesType;
    // Resolve the release's target episodes through the seriesType-aware chokepoint. A
    // standard SxxExx/season-pack release resolves exactly as before, and a daily/anime
    // release (date / absolute number, no season) now resolves to its real DB episodes
    // instead of falling through to Season Unknown. Null → genuinely unparseable or no
    // matching episode (e.g. anime with an unpopulated absoluteNumber): keep the legacy
    // "import to Season Unknown, no episode marked" behaviour.
    const resolved = await this.media.resolveEpisodeTargets(seriesType, series[0].id, match);
    if (!resolved) {
      return this.importSeriesUnknownSeason(entry, series[0], candidates[0], root, safeSeries, releaseQuality, item, now);
    }

    const season = resolved.seasonNumber;
    const seasonEpisodes = await this.media.episodesInSeason(series[0].id, season);
    const epNumberById = new Map(seasonEpisodes.map((e) => [e.id, e.episodeNumber]));
    const epTitleById = new Map(seasonEpisodes.map((e) => [e.id, e.title]));
    const target = episodeTarget(series[0].id, season, seasonEpisodes, resolved.isSeasonPack);
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

    const targetDir = join(root, safeSeries, `Season ${season}`);
    await this.storage.ensureDir(targetDir);

    // Single-file, non-pack releases already know their episode(s) from the release title
    // itself — reuse that rather than re-parsing a possibly-uninformative filename. A
    // season pack's individual files each need their own filename parsed.
    const useReleaseLevelMatch = !resolved.isSeasonPack && resolved.episodes.length > 0 && candidates.length === 1;

    // Phase 1 (async): all external I/O — hardlink/copy every approved file — happens
    // before the transaction. No DB writes here, so a failure partway through never
    // requires a rollback of anything.
    interface AppliedFileIO { mediaFileId: string; path: string; relativePath: string; size: number; hardlinked: boolean; episodeIds: string[] }
    const appliedIO: AppliedFileIO[] = [];
    const rejected: RejectedFile[] = [];
    let fileIndex = 0;

    for (const file of candidates) {
      let episodesInFile: number[];
      if (useReleaseLevelMatch) {
        // Single-file: trust the release-title resolution (real DB episode numbers for
        // daily/anime, not raw match.episodes which is empty for date/absolute titles).
        episodesInFile = resolved.episodes.map((e) => e.episodeNumber);
      } else {
        const fileMatch = parseEpisodeRelease(baseNameOf(file.path));
        if (fileMatch.episodes.length > 0) {
          episodesInFile = fileMatch.episodes;
        } else if (fileMatch.dailyDate !== undefined || fileMatch.absoluteNumber !== undefined) {
          // Daily/anime filenames name a date/absolute number — resolve against the
          // series' own numbering and keep only episodes inside the resolved season.
          const fileResolved = await this.media.resolveEpisodeTargets(seriesType, series[0].id, fileMatch);
          episodesInFile = (fileResolved?.episodes ?? [])
            .filter((e) => e.seasonNumber === season)
            .map((e) => e.episodeNumber);
        } else {
          episodesInFile = [];
        }
      }
      const decision = decideImportFile(file, episodesInFile, knownEpisodes, releaseQuality, profile);
      if (!decision.approved) {
        rejected.push({ path: file.path, reasons: decision.rejections.map(rejectionLabel) });
        continue;
      }
      try {
        const io = await this.hardlinkSeriesFile(
          file, decision.episodeIds, epNumberById, epTitleById, targetDir, root, season,
          safeSeries, series[0].title, releaseQuality, cfg, fileIndex++,
        );
        appliedIO.push(io);
      } catch (err) {
        rejected.push({ path: file.path, reasons: [`apply_failed: ${(err as Error).message}`] });
      }
    }

    if (appliedIO.length === 0) {
      throw new Error(
        `No importable file for "${entry.title}" — ${rejected.length} file(s) rejected: ${rejected.map((r) => `${r.path} (${r.reasons.join(", ")})`).join("; ")}`,
      );
    }

    // Upgrade-replace: an old file is only removed once every episode it covered has a
    // newly-imported file — an old multi-episode file where only some episodes were
    // superseded this round is left alone rather than partially invalidated. The
    // superseded file goes through the recycle bin (gap report B7) rather than an outright
    // delete, when one is configured.
    const newlyCovered = new Set(appliedIO.flatMap((f) => f.episodeIds));
    const toDeleteOld = existing.filter((f) => f.episodeIds.length > 0 && f.episodeIds.every((id) => newlyCovered.has(id)));

    // Phase 2 (sync): every DB write for this import lands atomically — either the whole
    // set of new media_file rows, episode.hasFile flips, superseded-file deletes,
    // availability update, history entry and queue-entry status change all land, or none do.
    const imported: ImportedFile[] = appliedIO.map((io) => ({ mediaFileId: io.mediaFileId, path: io.path, size: io.size, hardlinked: io.hardlinked, episodeIds: io.episodeIds }));
    if (this.db.dbDialect === "postgres") {
      // better-sqlite3's native tx wrapper needs a sync callback; node-postgres needs async
      // (P2 item 12 Stage 2) — two irreconcilable signatures, so Postgres gets its own body.
      await this.db.transaction(async (tx) => {
        for (const io of appliedIO) {
          await tx.insert(schema.mediaFile).values({
            id: io.mediaFileId, mediaType: "series", mediaId: series[0].id,
            relativePath: io.relativePath, size: io.size, quality: releaseQuality, dateAdded: now,
          });
          for (const epId of io.episodeIds) {
            // J3: flip episode.has_file AND point the episode at its covering file via the indexed
            // media_file_id FK — the single source of coverage truth now (the episode_ids JSON
            // column is gone). Supersession derives coverage from this same FK inverse.
            await tx.update(schema.episode).set({ hasFile: true, mediaFileId: io.mediaFileId }).where(eq(schema.episode.id, epId));
          }
        }
        for (const f of toDeleteOld) {
          await tx.delete(schema.mediaFile).where(eq(schema.mediaFile.id, f.id));
        }
        await this.markAvailability(tx, "series", series[0].id, now);
        await this.insertHistory(tx, "series", series[0].id, now, {
          title: releaseTitle, downloadId: item.downloadId, season,
          imported: imported.map((f) => ({ mediaFileId: f.mediaFileId, path: f.path, episodes: f.episodeIds.map((id) => epNumberById.get(id)) })),
          rejected,
        });
        await this.markEntryImported(tx, entry, now);
      });
    } else {
      this.db.transaction((tx) => {
        for (const io of appliedIO) {
          tx.insert(schema.mediaFile).values({
            id: io.mediaFileId, mediaType: "series", mediaId: series[0].id,
            relativePath: io.relativePath, size: io.size, quality: releaseQuality, dateAdded: now,
          }).run();
          for (const epId of io.episodeIds) {
            // J3 (sync body — SQLite path): has_file + the media_file_id FK pointer (coverage truth).
            tx.update(schema.episode).set({ hasFile: true, mediaFileId: io.mediaFileId }).where(eq(schema.episode.id, epId)).run();
          }
        }
        for (const f of toDeleteOld) {
          tx.delete(schema.mediaFile).where(eq(schema.mediaFile.id, f.id)).run();
        }
        this.markAvailabilitySync(tx, "series", series[0].id, now);
        this.insertHistorySync(tx, "series", series[0].id, now, {
          title: releaseTitle, downloadId: item.downloadId, season,
          imported: imported.map((f) => ({ mediaFileId: f.mediaFileId, path: f.path, episodes: f.episodeIds.map((id) => epNumberById.get(id)) })),
          rejected,
        });
        this.markEntryImportedSync(tx, entry, now);
      });
    }

    // Phase 3 (async, best-effort): physical deletion of superseded files, only after the
    // DB transaction that stopped referencing them has committed — if this step fails or
    // the process crashes here, a stale file is left on disk but no row points at it,
    // which is recoverable (a later scan/cleanup), unlike deleting the file before the DB
    // change is durable, which would be silent data loss with no compensating record.
    for (const f of toDeleteOld) {
      await this.recycleBin.dispose(join(root, f.relativePath)).catch((err) => {
        this.logger.warn(`Failed to dispose of superseded file ${f.relativePath}: ${(err as Error).message}`);
      });
    }

    const first = imported[0];
    this.emitImport("series", series[0].id, series[0].title, item.downloadId, first.path, first.mediaFileId, {
      season, filesImported: imported.length, filesRejected: rejected.length,
      episodes: imported.flatMap((f) => f.episodeIds),
    });
    return { imported, rejected };
  }

  /** Hardlink/copy one approved series file into place. External I/O only — no DB write —
   *  so it can run before the transaction that records it (see importSeries's phase split). */
  private async hardlinkSeriesFile(
    file: { path: string; size: number },
    episodeIds: string[],
    epNumberById: Map<string, number>,
    epTitleById: Map<string, string>,
    targetDir: string,
    root: string,
    season: number,
    safeSeries: string,
    rawSeriesTitle: string,
    quality: Quality,
    cfg: RuntimeSettings,
    fileIndex: number,
  ): Promise<{ mediaFileId: string; path: string; relativePath: string; size: number; hardlinked: boolean; episodeIds: string[] }> {
    const baseName = episodeIds.length > 0
      ? episodeFileName(cfg, rawSeriesTitle, season, episodeIds.map((id) => ({
          number: epNumberById.get(id) ?? 0, title: epTitleById.get(id) ?? "",
        })), quality)
      // Unmatched file inside a pack (couldn't tell which episode it is) — disambiguate
      // with the original filename rather than colliding with siblings on a shared name.
      // No episode identity to build a template from, so this keeps its ad hoc naming.
      : `${safeSeries} - S${pad2(season)} - ${fileIndex}-${baseNameOf(file.path).replace(extname(file.path), "")}`;
    const targetFile = join(targetDir, `${baseName}${extname(file.path)}`);
    const hardlinked = await this.storage.hardlink(file.path, targetFile);
    if (!existsSync(targetFile)) await this.storage.copy(file.path, targetFile);
    const size = statSync(targetFile).size;

    return { mediaFileId: newEntityId("mf"), path: targetFile, relativePath: relative(root, targetFile), size, hardlinked, episodeIds };
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
    const relativePath = relative(root, targetFile);
    if (this.db.dbDialect === "postgres") {
      // better-sqlite3's native tx wrapper needs a sync callback; node-postgres needs async
      // (P2 item 12 Stage 2) — two irreconcilable signatures, so Postgres gets its own body.
      await this.db.transaction(async (tx) => {
        await tx.insert(schema.mediaFile).values({
          id: mediaFileId, mediaType: "series", mediaId: series.id,
          relativePath, size, quality, dateAdded: now,
        });
        await this.markAvailability(tx, "series", series.id, now);
        await this.insertHistory(tx, "series", series.id, now, {
          title: entry.title, downloadId: item.downloadId, path: targetFile, size, mediaFileId, hardlinked, episodeMatched: false,
        });
        await this.markEntryImported(tx, entry, now);
      });
    } else {
      this.db.transaction((tx) => {
        tx.insert(schema.mediaFile).values({
          id: mediaFileId, mediaType: "series", mediaId: series.id,
          relativePath, size, quality, dateAdded: now,
        }).run();
        this.markAvailabilitySync(tx, "series", series.id, now);
        this.insertHistorySync(tx, "series", series.id, now, {
          title: entry.title, downloadId: item.downloadId, path: targetFile, size, mediaFileId, hardlinked, episodeMatched: false,
        });
        this.markEntryImportedSync(tx, entry, now);
      });
    }
    this.emitImport("series", series.id, series.title, item.downloadId, targetFile, mediaFileId);
    return { imported: [{ mediaFileId, path: targetFile, size, hardlinked, episodeIds: [] }], rejected: [] };
  }

  /**
   * Update the availability row for a title. Sync — for use inside a `db.transaction()`
   * callback, which every caller of this method now is (import writes are all
   * transactional as of roadmap P0.7).
   *
   * This previously matched on mediaId alone with no upsert and swallowed every error, so
   * when the row was missing — which happened for any series added before the availability
   * insert was made reliable, and for anything created by the upstream importer — the
   * update matched nothing and availability stayed "unknown" forever, silently.
   */
  private markAvailabilitySync(tx: Tx, mediaType: "movie" | "series", mediaId: string, now: string): void {
    const status = mediaType === "movie" ? "available" : this.seriesAvailabilitySync(tx, mediaId);
    ensureAvailabilitySync(tx, mediaType, mediaId);
    tx.update(schema.mediaAvailability)
      .set({ status, lastAvailabilitySyncAt: now })
      .where(and(
        eq(schema.mediaAvailability.mediaType, mediaType),
        eq(schema.mediaAvailability.mediaId, mediaId),
      ))
      .run();
  }

  /** A series is fully available only once no monitored episode is still missing. */
  private seriesAvailabilitySync(tx: Tx, seriesId: string): "available" | "partially_available" {
    const missing = tx.select({ n: count() }).from(schema.episode)
      .where(and(
        eq(schema.episode.seriesId, seriesId),
        eq(schema.episode.monitored, true),
        eq(schema.episode.hasFile, false),
      ))
      .all();
    return Number(missing[0]?.n ?? 0) === 0 ? "available" : "partially_available";
  }

  private insertHistorySync(tx: Tx, mediaType: string, mediaId: string, now: string, data: Record<string, unknown>): void {
    tx.insert(schema.historyEntry).values({
      id: newEntityId("hist"), mediaType, mediaId, action: "import_completed", data, createdAt: now,
    }).run();
  }

  /**
   * Close out a queue entry after a successful import. Sync — see markAvailabilitySync.
   *
   * The download is deliberately LEFT IN THE CLIENT. Torrents need to keep seeding to meet
   * tracker ratio requirements, and the imported library file is typically a hardlink to
   * the client's data, so pulling the download also risks the payload. Reaping completed
   * downloads belongs to a seed-goal policy (roadmap P2), not to import. The `imported`
   * status is terminal, so the monitor will not touch this entry again.
   */
  private markEntryImportedSync(tx: Tx, entry: QueueEntryRow, now: string): void {
    tx.update(schema.downloadQueueEntry)
      .set({ status: "imported", progress: 100, errorMessage: null, updatedAt: now })
      .where(eq(schema.downloadQueueEntry.id, entry.id))
      .run();
  }

  /** Async counterpart of `markAvailabilitySync`, for use inside a Postgres transaction
   *  callback (roadmap P2 item 12 Stage 2 — Postgres transaction bodies are async). */
  private async markAvailability(tx: Tx, mediaType: "movie" | "series", mediaId: string, now: string): Promise<void> {
    const status = mediaType === "movie" ? "available" : await this.seriesAvailability(tx, mediaId);
    await ensureAvailabilityTx(tx, mediaType, mediaId);
    await tx.update(schema.mediaAvailability)
      .set({ status, lastAvailabilitySyncAt: now })
      .where(and(
        eq(schema.mediaAvailability.mediaType, mediaType),
        eq(schema.mediaAvailability.mediaId, mediaId),
      ));
  }

  /** Async counterpart of `seriesAvailabilitySync`, for use inside a Postgres transaction. */
  private async seriesAvailability(tx: Tx, seriesId: string): Promise<"available" | "partially_available"> {
    const missing = await tx.select({ n: count() }).from(schema.episode)
      .where(and(
        eq(schema.episode.seriesId, seriesId),
        eq(schema.episode.monitored, true),
        eq(schema.episode.hasFile, false),
      ));
    return Number(missing[0]?.n ?? 0) === 0 ? "available" : "partially_available";
  }

  /** Async counterpart of `insertHistorySync`, for use inside a Postgres transaction. */
  private async insertHistory(tx: Tx, mediaType: string, mediaId: string, now: string, data: Record<string, unknown>): Promise<void> {
    await tx.insert(schema.historyEntry).values({
      id: newEntityId("hist"), mediaType, mediaId, action: "import_completed", data, createdAt: now,
    });
  }

  /** Async counterpart of `markEntryImportedSync`, for use inside a Postgres transaction. */
  private async markEntryImported(tx: Tx, entry: QueueEntryRow, now: string): Promise<void> {
    await tx.update(schema.downloadQueueEntry)
      .set({ status: "imported", progress: 100, errorMessage: null, updatedAt: now })
      .where(eq(schema.downloadQueueEntry.id, entry.id));
  }

  /**
   * Remove-completed-downloads policy (D3): when the client's config has `removeOnImport: true`,
   * pull the just-imported download out of the client immediately. Best-effort — a failure to
   * remove is logged, never fatal (the entry is already terminal/imported). Defaults to
   * `deleteData=false` to preserve the payload (the library file is typically a hardlink).
   */
  private async applyRemoveOnImport(client: ConfiguredClient, item: ClientQueueItem): Promise<void> {
    const settings = (client.row?.settings ?? {}) as Record<string, unknown>;
    if (settings.removeOnImport !== true) return;
    if (!item.downloadId) return;
    try {
      await client.provider.remove(item.downloadId);
    } catch (err) {
      this.logger.warn(`removeOnImport failed for "${item.title}" (${client.row?.id ?? "memory"}): ${(err as Error).message}`);
    }
  }

  /**
   * Seed-goal policy (D3): for torrent clients with a `seedRatioGoal` and/or `seedTimeMinutes`
   * configured, reap completed torrents that have satisfied both set goals. Only torrents WE
   * imported (queue entry status `imported`) are reaped — a completed torrent with no media
   * import (no mapped library file) is never removed, since that would throw away the only
   * copy. Removal keeps the payload (`deleteData=false`), stopping the seed once goals are met.
   * Runs inline from syncAll — no separate job row.
   */
  private async seedGoalSweep(client: ConfiguredClient): Promise<number> {
    const settings = (client.row?.settings ?? {}) as Record<string, unknown>;
    const clientId = client.row?.id ?? null;
    const ratioGoal = asNumber(settings.seedRatioGoal);
    const timeGoalMin = asNumber(settings.seedTimeMinutes);
    if ((ratioGoal === undefined || ratioGoal <= 0) && (timeGoalMin === undefined || timeGoalMin <= 0)) return 0;
    if (client.row?.kind !== "torrent" || clientId === null) return 0;
    const timeGoalSec = timeGoalMin && timeGoalMin > 0 ? timeGoalMin * 60 : undefined;

    const items = await client.provider.getQueue();
    let removed = 0;
    for (const item of items) {
      if (item.status !== "completed" || !item.downloadId) continue;
      const entry = await this.findEntry(clientId, item.downloadId);
      if (!entry || entry.status !== "imported") continue; // never reap what we haven't imported
      // All configured goals must be met (AND, standard seed-criteria semantics); an unset
      // goal (0 / absent) is treated as already satisfied so setting only one still works.
      const ratio = item.ratio;
      const seedSec = item.seedTimeSeconds;
      const ratioOk = ratioGoal === undefined || ratioGoal <= 0 || (ratio !== undefined && ratio >= ratioGoal);
      const timeOk = timeGoalSec === undefined || (seedSec !== undefined && seedSec >= timeGoalSec);
      if (!ratioOk || !timeOk) continue;
      try {
        await client.provider.remove(item.downloadId, false);
        await this.db.update(schema.downloadQueueEntry)
          .set({ status: "removed", updatedAt: new Date().toISOString() })
          .where(eq(schema.downloadQueueEntry.id, entry.id));
        removed++;
      } catch (err) {
        this.logger.warn(`seed-goal removal failed for "${item.title}" (${clientId}): ${(err as Error).message}`);
      }
    }
    return removed;
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
    // explicit content path from the client (qbittorrent: content_path / save_path) —
    // translated through any configured remote path mapping first (roadmap P1, gap report
    // B8): the client reports its own filesystem view, which may not exist from here.
    if (item.contentPath) {
      const path = await this.translateRemotePath(item.contentPath, entry.downloadClientId);
      if (isVideo(path)) return { kind: "file", path, size: statSyncSafe(path) };
      if (existsSync(path)) return { kind: "dir", path };
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

  /** Rewrites a client-reported path's `remotePath` prefix to the matching `localPath`, if
   *  any configured mapping applies — the longest matching prefix wins when more than one
   *  does. Returns the path unchanged when no mapping is configured for this client, or
   *  when none of its mappings' prefixes match. */
  private async translateRemotePath(path: string, downloadClientId: string | null): Promise<string> {
    if (!downloadClientId) return path;
    const mappings = await this.remotePathMappings.forClient(downloadClientId);
    const match = mappings.find((m) => path.startsWith(m.remotePath));
    return match ? join(match.localPath, relative(match.remotePath, path)) : path;
  }

  private async resolveRoot(mediaRoot: string, fallback: string, mediaType: "movie" | "series"): Promise<string> {
    if (mediaRoot) return mediaRoot;
    const configured = await this.rootFolders.getDefault(mediaType);
    return configured?.path || fallback;
  }

  /** Mirrors the decision engine's free-space specification (roadmap P1, gap report B8)
   *  at the point it matters most: about to write the actual bytes. The grab-time check
   *  can go stale (another download landed in between, or the estimate was off), so this
   *  is a real guard, not just a decision-time convenience — it throws, routing through
   *  the same import-failure/retry path as any other import error. Skipped when free
   *  space can't be determined (root not yet accessible), matching the domain spec's
   *  permissive default for unknown state. */
  private async assertSufficientFreeSpace(root: string, neededBytes: number, cfg: RuntimeSettings): Promise<void> {
    const { free } = await this.storage.diskFree(root);
    if (free < 0) return;
    const marginBytes = cfg["media.minimumFreeSpaceMb"] * 1024 * 1024;
    if (free - neededBytes < marginBytes) {
      throw new Error(
        `insufficient free space on "${root}": importing would leave less than the configured ${cfg["media.minimumFreeSpaceMb"]}MB free`,
      );
    }
  }
}

function sanitizeEntry(title: string): string {
  return title.replace(/[^A-Za-z0-9 _()[\]-]/g, "").trim() || "download";
}

/** Tolerant numeric read of a settings value (e.g. seedRatioGoal) — undefined when absent. */
function asNumber(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** A minimal "completed" client item used to drive `importCompletedEntry` for a queue
 *  entry on demand (retry / manual-import): `resolveContent` only consults
 *  `item.contentPath` / `downloadId`, and the history/emit paths only use `downloadId` +
 *  `title` — `status` is never read inside the import. `contentPath` encodes the
 *  manual-import explicit path (or undefined = auto-resolve). */
function syntheticCompletedItem(entry: QueueEntryRow, contentPath?: string): ClientQueueItem {
  return {
    downloadId: entry.downloadId ?? "",
    title: entry.title,
    status: "completed",
    progress: 100,
    size: entry.size ?? 0,
    contentPath,
  };
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
