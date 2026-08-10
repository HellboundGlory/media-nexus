// SPDX-License-Identifier: MIT
import { Inject, Injectable } from "@nestjs/common";
import { asc, desc, eq } from "drizzle-orm";
import { ApiError, newEntityId } from "@medianexus/shared";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import type { Release, CreateIndexer } from "@medianexus/domain";
import { ProvidersService } from "../providers/demo.providers";
import { EventsService } from "../events/events.service";
import { EventTypes } from "@medianexus/events";
import { z } from "zod";
import { newznabSettingsSchema, torznabSettingsSchema, memoryIndexerSettingsSchema } from "@medianexus/integrations";
import { ConfigService } from "../system/config.service";
import { join, resolve } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";

const settingsSchemas: Record<string, z.ZodType> = {
  memory: memoryIndexerSettingsSchema,
  newznab: newznabSettingsSchema,
  torznab: torznabSettingsSchema,
};

@Injectable()
export class IndexersService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly providers: ProvidersService,
    private readonly events: EventsService,
    private readonly config: ConfigService,
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

  /** Search all enabled indexers through their providers (real HTTP for newznab/torznab). */
  async search(input: { mediaType: "movie" | "series"; mediaId: string; query?: string }) {
    const configured = await this.providers.configuredIndexers();
    const results: Release[] = [];
    for (const { row, provider } of configured) {
      try {
        const releases = await provider.search({
          mediaType: input.mediaType,
          query: input.query,
          categories: undefined,
          limit: 20,
        });
        for (const r of releases) {
          results.push({ ...r, indexerId: row.id, indexerName: row.name });
        }
      } catch (err) {
        this.events.publish(EventTypes.IndexerFailed, { indexerId: row.id, error: (err as Error).message }, { aggType: "indexer", aggId: row.id });
      }
    }
    return { mediaType: input.mediaType, mediaId: input.mediaId, releases: results };
  }

  /** Grab a release: choose a download client by protocol, add it, and mirror into the unified queue. */
  async grab(input: { mediaType: "movie" | "series"; mediaId: string; releaseId: string; indexerId?: string; downloadClientId?: string }) {
    // locate the release by searching configured indexers
    // Re-run the search (using the media title as the query) to resolve the release id.
    const configured = await this.providers.configuredIndexers();
    const query = await this.mediaTitle(input.mediaType, input.mediaId);
    let release: Release | null = null;
    for (const { row, provider } of configured) {
      let found: Release | null = null;
      if (row.id === input.indexerId || !input.indexerId) {
        const releases = await provider.search({ mediaType: input.mediaType, query }).catch(() => []);
        found = releases.find((r) => r.id === input.releaseId) ?? null;
        if (!found) {
          // fall back to catalog/RSS search (some providers only return the release there)
          const all = await provider.search({ mediaType: input.mediaType, query: "" }).catch(() => []);
          found = all.find((r) => r.id === input.releaseId) ?? null;
        }
      }
      if (found) { release = { ...found, indexerId: row.id, indexerName: row.name }; break; }
    }
    if (!release) throw ApiError.notFound("release", input.releaseId);

    const client = await this.providers.pickDownloadClient(release.protocol as "usenet" | "torrent", input.downloadClientId);
    const { downloadId } = await client.provider.addRelease({ release, category: input.mediaType });

    const now = new Date().toISOString();
    const queueId = newEntityId("q");
    const data: Record<string, unknown> = {
      releaseId: release.id,
      releaseTitle: release.title,
      indexerId: input.indexerId ?? release.indexerId,
      downloadId,
      quality: release.quality,
      protocol: release.protocol,
      size: release.size,
      category: input.mediaType,
    };
    // demo flow (memory client): create a placeholder "downloaded" file so the importer has something to move
    if (!client.row) {
      const cfg = await this.config.get();
      const downloadsRoot = cfg["paths.downloads"] || resolve(process.cwd(), "data", "downloads");
      const dir = join(downloadsRoot, safePlaceholder(release.title));
      mkdirSync(dir, { recursive: true });
      const placeholder = join(dir, `${safePlaceholder(release.title)}.mkv`);
      writeFileSync(placeholder, Buffer.alloc(1024));
      data.completedPath = placeholder;
    }

    await this.db.insert(schema.downloadQueueEntry).values({
      id: queueId,
      mediaType: input.mediaType,
      mediaId: input.mediaId,
      downloadClientId: client.row?.id ?? null,
      downloadId,
      title: release.title,
      status: "downloading",
      progress: 5,
      size: release.size,
      remainingTime: null,
      data,
      addedAt: now,
      updatedAt: now,
    });
    await this.db.insert(schema.historyEntry).values({
      id: newEntityId("hist"),
      mediaType: input.mediaType,
      mediaId: input.mediaId,
      action: "grabbed",
      data,
      createdAt: now,
    });
    const agg = { aggType: input.mediaType, aggId: input.mediaId };
    this.events.publish(EventTypes.ReleaseGrabbed, { releaseId: release.id, title: release.title, downloadId, mediaType: input.mediaType, mediaId: input.mediaId }, agg);
    this.events.publish(EventTypes.DownloadStarted, { downloadId, title: release.title }, agg);
    return { queueId, downloadId, client: client.row?.name ?? "memory", release: { id: release.id, title: release.title, quality: release.quality } };
  }

  private async mediaTitle(mediaType: "movie" | "series", mediaId: string): Promise<string> {
    if (mediaType === "movie") {
      const rows = await this.db.select({ t: schema.movie.title }).from(schema.movie).where(eq(schema.movie.id, mediaId)).limit(1);
      return rows[0]?.t ?? "";
    }
    const rows = await this.db.select({ t: schema.series.title }).from(schema.series).where(eq(schema.series.id, mediaId)).limit(1);
    return rows[0]?.t ?? "";
  }
}

function safePlaceholder(s: string): string {
  return s.replace(/[^A-Za-z0-9 _()[\]-]/g, "").trim() || "download";
}
