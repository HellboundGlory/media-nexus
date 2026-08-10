// SPDX-License-Identifier: MIT
import { Inject, Injectable } from "@nestjs/common";
import { asc, desc, eq } from "drizzle-orm";
import { ApiError, newEntityId } from "@medianexus/shared";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import type { Release, CreateIndexer } from "@medianexus/domain";
import {
  MEMORY_INDEXER, MEMORY_DOWNLOAD_CLIENT,
} from "../providers/demo.providers";
import type { MemoryIndexerProvider, MemoryDownloadClientProvider } from "@medianexus/integrations";
import { EventsService } from "../events/events.service";
import { EventTypes } from "@medianexus/events";
import { z } from "zod";
import { newznabSettingsSchema, torznabSettingsSchema, memoryIndexerSettingsSchema } from "@medianexus/integrations";

const settingsSchemas: Record<string, z.ZodType> = {
  memory: memoryIndexerSettingsSchema,
  newznab: newznabSettingsSchema,
  torznab: torznabSettingsSchema,
};

@Injectable()
export class IndexersService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    @Inject(MEMORY_INDEXER) private readonly memIndexer: MemoryIndexerProvider,
    @Inject(MEMORY_DOWNLOAD_CLIENT) private readonly memClient: MemoryDownloadClientProvider,
    private readonly events: EventsService,
  ) {}

  definitions() {
    return this.db.select().from(schema.indexerDefinition).orderBy(asc(schema.indexerDefinition.name));
  }

  list() {
    return this.db.select().from(schema.indexer).orderBy(desc(schema.indexer.createdAt));
  }

  async get(id: string) {
    const rows = await this.db.select().from(schema.indexer).where(eq(schema.indexer.id, id)).limit(1);
    if (!rows[0]) throw ApiError.notFound("indexer", id);
    return rows[0];
  }

  async create(input: CreateIndexer) {
    const def = await this.db.select().from(schema.indexerDefinition).where(eq(schema.indexerDefinition.key, input.definitionKey)).limit(1);
    if (!def[0]) throw new ApiError({ code: "VALIDATION_ERROR", message: `Unknown indexer definition key "${input.definitionKey}"` });
    const impl = def[0].implementation;
    const s = settingsSchemas[impl];
    if (!s) {
      throw new ApiError({ code: "VALIDATION_ERROR", message: `Indexer implementation "${impl}" not available yet (M1 adds Newznab/Torznab HTTP)` });
    }
    const parsed = s.safeParse(input.settings);
    if (!parsed.success) {
      throw new ApiError({ code: "VALIDATION_ERROR", message: `Invalid settings for ${impl}`, details: parsed.error.issues });
    }
    const now = new Date().toISOString();
    const row = {
      id: newEntityId("idx"),
      definitionKey: input.definitionKey,
      name: input.name,
      protocol: input.protocol,
      enabled: input.enabled ?? true,
      implementation: impl,
      settings: parsed.data as Record<string, unknown>,
      proxy: input.proxy ?? null,
      priority: input.priority ?? 25,
      status: "ok",
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(schema.indexer).values(row);
    return row;
  }

  async remove(id: string) {
    await this.get(id);
    await this.db.delete(schema.indexer).where(eq(schema.indexer.id, id));
    return { removed: id };
  }

  /** Demo search: runs every enabled `memory` indexer (real HTTP providers in M1). */
  async search(input: { mediaType: "movie" | "series"; mediaId: string; query?: string }) {
    const configured = await this.db.select().from(schema.indexer).where(eq(schema.indexer.enabled, true));
    const results: Release[] = [];
    for (const idx of configured) {
      if (idx.implementation !== "memory") continue; // not available until M1
      const releases = await this.memIndexer.search({
        mediaType: input.mediaType,
        query: input.query,
        categories: [],
        limit: 20,
      });
      for (const r of releases) {
        results.push({ ...r, indexerId: idx.id, indexerName: idx.name });
      }
    }
    return { mediaType: input.mediaType, mediaId: input.mediaId, releases: results };
  }

  /** Demo grab: find release via the memory indexer, add via the memory download client. */
  async grab(input: { mediaType: "movie" | "series"; mediaId: string; releaseId: string; indexerId?: string }) {
    const releases = await this.memIndexer.search({ mediaType: input.mediaType, query: "" });
    const release = releases.find((r) => r.id === input.releaseId);
    if (!release) throw ApiError.notFound("release", input.releaseId);

    const { downloadId } = await this.memClient.addRelease({ release, category: input.mediaType });
    const now = new Date().toISOString();
    const queueId = newEntityId("q");
    await this.db.insert(schema.downloadQueueEntry).values({
      id: queueId,
      mediaType: input.mediaType,
      mediaId: input.mediaId,
      downloadClientId: null,
      downloadId,
      title: release.title,
      status: "downloading",
      progress: 5,
      size: release.size,
      remainingTime: null,
      addedAt: now,
      updatedAt: now,
    });
    await this.db.insert(schema.historyEntry).values({
      id: newEntityId("hist"),
      mediaType: input.mediaType,
      mediaId: input.mediaId,
      action: "grabbed",
      data: {
        releaseId: release.id,
        releaseTitle: release.title,
        indexerId: input.indexerId ?? release.indexerId,
        downloadId,
        quality: release.quality,
        protocol: release.protocol,
        size: release.size,
      },
      createdAt: now,
    });
    const agg = { aggType: input.mediaType, aggId: input.mediaId };
    this.events.publish(EventTypes.ReleaseGrabbed, { releaseId: release.id, title: release.title, downloadId, mediaType: input.mediaType, mediaId: input.mediaId }, agg);
    this.events.publish(EventTypes.DownloadStarted, { downloadId, title: release.title }, agg);
    return { queueId, downloadId, release: { id: release.id, title: release.title, quality: release.quality } };
  }
}

