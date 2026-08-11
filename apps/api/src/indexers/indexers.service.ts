// SPDX-License-Identifier: MIT
import { Inject, Injectable } from "@nestjs/common";
import { asc, desc, eq, sql as dsql } from "drizzle-orm";
import { ApiError, newEntityId } from "@medianexus/shared";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import type { Release, CreateIndexer } from "@medianexus/domain";
import { ProvidersService } from "../providers/demo.providers";
import { redactSettings } from "../common/redact";
import { EventsService } from "../events/events.service";
import { EventTypes } from "@medianexus/events";
import { z } from "zod";
import { newznabSettingsSchema, torznabSettingsSchema, memoryIndexerSettingsSchema } from "@medianexus/integrations";
import { ConfigService } from "../system/config.service";
import { join, resolve } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { episodeQueryTag } from "@medianexus/domain";
import { parseCardigannYaml, cardigannSettingsSchema } from "@medianexus/integrations";

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

  async definitions() {
    const rows = await this.db.select().from(schema.indexerDefinition).orderBy(asc(schema.indexerDefinition.name));
    // "memory" stays seeded (test infra creates indexers against it) but is never real —
    // never surface it to a real client browsing definitions.
    return rows.filter((def) => def.implementation !== "memory").map((def) => {
      let settingsSchema: { name: string; label?: string; type: string; default?: string | number | boolean; required: boolean; options?: string[] }[] | undefined;
      if (def.implementation === "cardigann" && def.cardigannYml) {
        try {
          const parsed = parseCardigannYaml(def.cardigannYml);
          settingsSchema = parsed.settings?.map((s) => ({ name: s.name, label: s.label, type: s.type, default: s.default, required: Boolean(s.required), options: s.options }));
        } catch { /* leave undefined */ }
      }
      return { ...def, settingsSchema };
    });
  }

  /** Create a custom Cardigann definition (validated YAML) → selectable like built-ins. */
  async createDefinition(input: { key: string; name: string; protocol: "usenet" | "torrent"; cardigannYml: string }) {
    try { parseCardigannYaml(input.cardigannYml); } catch (err) {
      throw new ApiError({ code: "VALIDATION_ERROR", message: `Invalid Cardigann YAML: ${(err as Error).message}` });
    }
    const existing = await this.db.select().from(schema.indexerDefinition).where(eq(schema.indexerDefinition.key, input.key)).limit(1);
    const now = new Date().toISOString();
    if (existing[0]) {
      await this.db.update(schema.indexerDefinition)
        .set({ name: input.name, protocol: input.protocol, cardigannYml: input.cardigannYml })
        .where(eq(schema.indexerDefinition.key, input.key));
      return { updated: input.key };
    }
    await this.db.insert(schema.indexerDefinition).values({
      id: newEntityId("idef"),
      key: input.key,
      name: input.name,
      protocol: input.protocol,
      implementation: "cardigann",
      builtIn: false,
      capabilities: { search: true },
      categoryIds: [],
      cardigannYml: input.cardigannYml,
      createdAt: now,
    });
    return { created: input.key };
  }

  list() {
    return this.db.select().from(schema.indexer).orderBy(desc(schema.indexer.createdAt)).then((rows) =>
      rows.map((r) => ({ ...r, settings: redactSettings(r.settings), proxy: r.proxy ? redactSettings(r.proxy) : null })),
    );
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

    let parsedSettings: Record<string, unknown>;
    if (impl === "cardigann") {
      if (!def[0].cardigannYml) throw new ApiError({ code: "VALIDATION_ERROR", message: "Cardigann definition has no YAML body" });
      const parsed = parseCardigannYaml(def[0].cardigannYml);
      const res = cardigannSettingsSchema(parsed).safeParse(input.settings);
      if (!res.success) throw new ApiError({ code: "VALIDATION_ERROR", message: `Invalid settings for ${def[0].name}`, details: res.error.issues });
      parsedSettings = res.data as Record<string, unknown>;
    } else {
      const s = settingsSchemas[impl];
      if (!s) {
        throw new ApiError({ code: "VALIDATION_ERROR", message: `Indexer implementation "${impl}" not available yet` });
      }
      const parsed = s.safeParse(input.settings);
      if (!parsed.success) {
        throw new ApiError({ code: "VALIDATION_ERROR", message: `Invalid settings for ${impl}`, details: parsed.error.issues });
      }
      parsedSettings = parsed.data as Record<string, unknown>;
    }

    const now = new Date().toISOString();
    const row = {
      id: newEntityId("idx"),
      definitionKey: input.definitionKey,
      name: input.name,
      protocol: input.protocol,
      enabled: input.enabled ?? true,
      implementation: impl,
      settings: parsedSettings,
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

  /** Run a live health check on one configured indexer and persist the result. */
  async test(id: string) {
    const row = await this.get(id);
    const { provider } = await this.bestProviderFor(row);
    if (!provider) throw new ApiError({ code: "UNPROCESSABLE", message: "No provider for this indexer" });
    const health = await provider.healthcheck();
    const now = new Date().toISOString();
    await this.db.update(schema.indexer)
      .set({ status: health.ok ? "ok" : "error", lastError: health.ok ? null : (health.message ?? null), lastSyncAt: now, updatedAt: now })
      .where(eq(schema.indexer.id, id));
    if (!health.ok) {
      this.events.publish(EventTypes.IndexerFailed, { indexerId: id, error: health.message ?? "healthcheck failed" }, { aggType: "indexer", aggId: id });
    }
    return { id, ok: health.ok, latencyMs: health.latencyMs, message: health.message };
  }

  /** Health-check every enabled indexer (used by the discovery.indexerRefresh job). */
  async refreshAll(): Promise<{ checked: number; ok: number; failed: number }> {
    const configured = await this.providers.configuredIndexers();
    let ok = 0; let failed = 0;
    for (const { row } of configured) {
      const r = await this.test(row.id).catch((e) => ({ ok: false as const, message: (e as Error).message }));
      if (r.ok) ok++; else failed++;
    }
    return { checked: configured.length, ok, failed };
  }

  /** Per-indexer acquisition stats (from history). */
  async statistics() {
    const grabs = await this.db
      .select({
        indexerId: dsql`json_extract(${schema.historyEntry.data}, '$.indexerId')`,
        createdAt: schema.historyEntry.createdAt,
      })
      .from(schema.historyEntry)
      .where(eq(schema.historyEntry.action, "grabbed"))
      .orderBy(desc(schema.historyEntry.createdAt))
      .limit(2000);
    const rows = await this.list();
    const stats = rows.map((r) => {
      const mine = grabs.filter((g) => String(g.indexerId) === String(r.id));
      const total = mine.length;
      const last = mine[0]?.createdAt ?? null;
      return { id: r.id, name: r.name, implementation: r.implementation, status: r.status, lastError: r.lastError, grabs: total, lastGrabAt: last };
    });
    return stats;
  }

  private async bestProviderFor(row: (typeof schema.indexer.$inferSelect)) {
    const configured = await this.providers.configuredIndexers();
    return configured.find((c) => c.row.id === row.id) ?? { row, provider: null as never };
  }

  async remove(id: string) {
    await this.get(id);
    await this.db.delete(schema.indexer).where(eq(schema.indexer.id, id));
    return { removed: id };
  }

  /** Search all enabled indexers through their providers (real HTTP for newznab/torznab).
   *  For series, an optional episode target augments the query with an SxxExx tag. */
  async search(input: { mediaType: "movie" | "series"; mediaId: string; query?: string; seasons?: number[]; episodes?: number[]; limit?: number }) {
    const limit = input.limit ?? 20;
    const query = this.buildQuery(input.query, input.seasons, input.episodes);
    const configured = await this.providers.configuredIndexers();
    const results: Release[] = [];
    for (const { row, provider } of configured) {
      try {
        const releases = await provider.search({ mediaType: input.mediaType, query, categories: undefined, limit });
        for (const r of releases) {
          results.push({ ...r, indexerId: row.id, indexerName: row.name });
        }
      } catch (err) {
        this.events.publish(EventTypes.IndexerFailed, { indexerId: row.id, error: (err as Error).message }, { aggType: "indexer", aggId: row.id });
      }
    }
    return { mediaType: input.mediaType, mediaId: input.mediaId, query, releases: results };
  }

  private buildQuery(base: string | undefined, seasons?: number[], episodes?: number[]): string {
    const parts = [base?.trim()].filter(Boolean);
    const s = seasons?.[0];
    const e = episodes?.[0];
    if (s !== undefined && e !== undefined) parts.push(episodeQueryTag(s, e));
    return parts.join(" ");
  }

  /** Grab a release: choose a download client by protocol, add it, and mirror into the unified queue.
   *  When `release` is supplied (RSS auto-grab) the search round-trip to re-resolve the id is skipped. */
  async grab(input: { mediaType: "movie" | "series"; mediaId: string; releaseId: string; indexerId?: string; downloadClientId?: string; release?: Release }) {
    let release: Release | null = input.release ?? null;
    if (!release) {
      // Re-run the search (using the media title as the query) to resolve the release id.
      const configured = await this.providers.configuredIndexers();
      const query = await this.mediaTitle(input.mediaType, input.mediaId);
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
    }

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
    // memory download client (test infra only): create a placeholder "downloaded" file so the importer has something to move
    if (client.row?.implementation === "memory") {
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
