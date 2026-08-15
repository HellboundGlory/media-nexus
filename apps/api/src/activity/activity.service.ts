// SPDX-License-Identifier: MIT
import { Inject, Injectable, Logger } from "@nestjs/common";
import { eq, inArray } from "drizzle-orm";
import { ApiError, newEntityId } from "@medianexus/shared";
import { schema } from "@medianexus/database";
import type { Db } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import { ProvidersService } from "../providers/demo.providers";

/**
 * The one manual-intervention write path this session's queue-reconciliation work (roadmap
 * B5) adds: clearing a stuck entry. Retry / manual-import / bulk-remove are a separate,
 * larger action surface (gap report C4) deliberately left out — without at least this much,
 * B5's own motivating complaint ("requires manual DB surgery") would still be literally
 * true for a stuck entry even after the reconciler ships.
 */
@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly providers: ProvidersService,
  ) {}

  async removeQueueEntry(id: string): Promise<{ removed: string }> {
    const rows = await this.db.select().from(schema.downloadQueueEntry).where(eq(schema.downloadQueueEntry.id, id)).limit(1);
    const entry = rows[0];
    if (!entry) throw ApiError.notFound("queue entry", id);

    // Best-effort, and deliberately not deleting the payload — the user is clearing the
    // row, not necessarily giving up on seeded/downloaded data (contrast
    // AcquisitionService.recordDownloadFailure(), which does delete data for a confirmed
    // failure).
    if (entry.downloadClientId && entry.downloadId) {
      const clients = await this.providers.configuredDownloadClients();
      const client = clients.find((c) => c.row?.id === entry.downloadClientId);
      if (client) {
        try {
          await client.provider.remove(entry.downloadId, false);
        } catch (err) {
          this.logger.warn(`failed to remove "${entry.title}" from its download client: ${(err as Error).message}`);
        }
      }
    }

    const now = new Date().toISOString();
    if (this.db.dbDialect === "postgres") {
      // better-sqlite3's native tx wrapper needs a sync callback; node-postgres needs async
      // (P2 item 12 Stage 2) — two irreconcilable signatures, so Postgres gets its own body.
      await this.db.transaction(async (tx) => {
        await tx.delete(schema.downloadQueueEntry).where(eq(schema.downloadQueueEntry.id, id));
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
        tx.delete(schema.downloadQueueEntry).where(eq(schema.downloadQueueEntry.id, id)).run();
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

    return { removed: id };
  }

  /** Bulk-remove multiple queue entries (roadmap C4). Same semantics as
   *  `removeQueueEntry` per id — best-effort client remove leaving client-side data, plus
   *  a `removed` history row — but skips entries that don't exist. Returns how many were
   *  actually removed. */
  async bulkRemoveQueue(ids: string[]): Promise<{ removed: number }> {
    let removed = 0;
    for (const id of ids) {
      const rows = await this.db.select().from(schema.downloadQueueEntry).where(eq(schema.downloadQueueEntry.id, id)).limit(1);
      const entry = rows[0];
      if (!entry) continue;
      if (entry.downloadClientId && entry.downloadId) {
        const client = (await this.providers.configuredDownloadClients()).find((c) => c.row?.id === entry.downloadClientId);
        if (client) {
          try {
            await client.provider.remove(entry.downloadId, false);
          } catch (err) {
            this.logger.warn(`failed to remove "${entry.title}" from its download client: ${(err as Error).message}`);
          }
        }
      }
      const now = new Date().toISOString();
      if (this.db.dbDialect === "postgres") {
        // better-sqlite3's native tx wrapper needs a sync callback; node-postgres needs async
        // (P2 item 12 Stage 2) — two irreconcilable signatures, so Postgres gets its own body.
        await this.db.transaction(async (tx) => {
          await tx.delete(schema.downloadQueueEntry).where(eq(schema.downloadQueueEntry.id, id));
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
          tx.delete(schema.downloadQueueEntry).where(eq(schema.downloadQueueEntry.id, id)).run();
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
      removed++;
    }
    return { removed };
  }

  /** Bulk-delete history entries (roadmap C4). Returns how many rows were removed. */
  async bulkRemoveHistory(ids: string[]): Promise<{ removed: number }> {
    if (ids.length === 0) return { removed: 0 };
    const res = await this.db.delete(schema.historyEntry).where(inArray(schema.historyEntry.id, ids));
    return { removed: res.changes };
  }
}
