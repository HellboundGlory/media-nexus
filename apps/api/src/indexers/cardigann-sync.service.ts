// SPDX-License-Identifier: MIT
import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { parse as parseYaml } from "yaml";
import { parseCardigannYaml, cardigannDefinitionStatus, type CardigannStatus } from "@medianexus/integrations";
import { ApiError, mapLimit, newEntityId } from "@medianexus/shared";
import { schema, type Db } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";

/** One upstream definition file, with a URL it can be fetched from. */
export interface UpstreamCardigannFile {
  name: string;
  rawUrl: string;
}
export interface CardigannUpstreamSource {
  list(): Promise<UpstreamCardigannFile[]>;
  fetch(file: UpstreamCardigannFile): Promise<string>;
}

/** Default source: the live Prowlarr/Indexers `definitions/v11` directory on GitHub. */
export class GithubCardigannSource implements CardigannUpstreamSource {
  constructor(private readonly listUrl = "https://api.github.com/repos/Prowlarr/Indexers/contents/definitions/v11") {}
  async list(): Promise<UpstreamCardigannFile[]> {
    const res = await fetch(this.listUrl, { headers: { "User-Agent": "media-nexus" } });
    if (!res.ok) throw new Error(`GitHub contents API responded HTTP ${res.status}`);
    const items = (await res.json()) as { name?: string; download_url?: string | null }[];
    return items
      .filter((i) => i?.name?.endsWith(".yml"))
      .map((i) => ({
        name: i.name as string,
        rawUrl: i.download_url ?? `https://raw.githubusercontent.com/Prowlarr/Indexers/master/definitions/v11/${i.name}`,
      }));
  }
  async fetch(file: UpstreamCardigannFile): Promise<string> {
    const res = await fetch(file.rawUrl, { headers: { "User-Agent": "media-nexus" } });
    if (!res.ok) throw new Error(`fetch ${file.name}: HTTP ${res.status}`);
    return res.text();
  }
}

/** How many upstream definitions are fetched in parallel (the repo has no p-limit helper). */
const SYNC_CONCURRENCY = 8;

export interface DefinitionSyncSummary {
  total: number;
  added: number;
  updated: number;
  skippedCustom: number;
  unsupported: number;
  failed: number;
  deprecated: number;
  removedOrphaned: number;
}

/**
 * Upstream Cardigann definition sync (roadmap D4, Stage 3 — `media.definitionSync` job).
 *
 * Fetches `definitions/v11/*.yml` from Prowlarr/Indexers, validates each against the Stage 1/2
 * interpreter, and upserts them as `builtIn: true` rows in `indexer_definition`, tagging each
 * with a supported/unsupported status (captcha, unimplemented filter, unknown template
 * function) so a broken definition is never silently exposed as usable.
 *
 * Safety invariants (the Plan-agent flags):
 *  - A key that collides with a user's *custom* (`builtIn: false`) definition is never
 *    clobbered — it's skipped.
 *  - A live built-in that disappears upstream (renamed/removed) is never hard-deleted while
 *    configured `indexer` rows still reference it (`indexer.definitionKey` has no FK, so a
 *    missing key would silently drop those indexers) — it's deprecated in place instead.
 *    An *orphaned* built-in (no referencing indexer) is removed safely.
 */
@Injectable()
export class CardigannSyncService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  /** Run a full sync. `source` is injectable for tests (defaults to live GitHub). */
  async run(source: CardigannUpstreamSource = new GithubCardigannSource()): Promise<DefinitionSyncSummary> {
    const files = await source.list().catch((e) => {
      throw new ApiError({ code: "UNPROCESSABLE", message: `Failed to list upstream Cardigann definitions: ${(e as Error).message}` });
    });

    const fetched = await mapLimit(files, SYNC_CONCURRENCY, async (file) => {
      const yml = await source.fetch(file).catch(() => null);
      return { file, yml };
    });

    const summary: DefinitionSyncSummary = { total: files.length, added: 0, updated: 0, skippedCustom: 0, unsupported: 0, failed: 0, deprecated: 0, removedOrphaned: 0 };
    const syncedKeys: string[] = [];
    const now = new Date().toISOString();

    for (const { file, yml } of fetched) {
      if (!yml) { summary.failed++; continue; }
      let key: string;
      let name: string;
      let status: CardigannStatus;
      try {
        const doc = (parseYaml(yml) ?? {}) as { id?: string };
        key = String(doc.id ?? file.name.replace(/\.yml$/, ""));
        const parsed = parseCardigannYaml(yml);
        name = parsed.name;
        status = cardigannDefinitionStatus(parsed);
      } catch {
        summary.failed++;
        continue;
      }
      if (!status.supported) summary.unsupported++;

      const existing = (await this.db.select().from(schema.indexerDefinition).where(eq(schema.indexerDefinition.key, key)).limit(1))[0];
      // No-clobber: a user's custom definition owns its key — never overwrite it.
      if (existing && !existing.builtIn) { summary.skippedCustom++; continue; }

      const capabilities = { search: true, cardigannStatus: status, upstream: "Prowlarr/Indexers", upstreamVersion: "v11" };
      if (existing) {
        await this.db.update(schema.indexerDefinition)
          .set({ name, cardigannYml: yml, capabilities })
          .where(eq(schema.indexerDefinition.key, key));
        summary.updated++;
      } else {
        await this.db.insert(schema.indexerDefinition).values({
          id: newEntityId("idef"), key, name,
          // Default protocol is `torrent`. Cardigann is the scraping framework built for
          // torrent trackers — they lack APIs and need YAML-based scraping. Usenet indexers
          // already have the Newznab protocol standard (Torznab/Newznab defs are handled
          // separately), which is why no usenet indexers appear in this Cardigann catalog.
          // Upstream Cardigann v11 defs carry no root `protocol` field, so synced built-ins
          // land here as torrent.
          protocol: "torrent",
          implementation: "cardigann", builtIn: true, capabilities, categoryIds: [], cardigannYml: yml, createdAt: now,
        });
        summary.added++;
      }
      syncedKeys.push(key);
    }

    await this.reconcileRemoved(syncedKeys, summary);
    return summary;
  }

  /** Handle built-in cardigann keys that are no longer present upstream. */
  private async reconcileRemoved(syncedKeys: string[], summary: DefinitionSyncSummary): Promise<void> {
    const rows = await this.db.select().from(schema.indexerDefinition).where(eq(schema.indexerDefinition.implementation, "cardigann"));
    for (const row of rows) {
      if (!row.builtIn || syncedKeys.includes(row.key)) continue;
      const references = await this.db
        .select({ id: schema.indexer.id })
        .from(schema.indexer)
        .where(eq(schema.indexer.definitionKey, row.key))
        .limit(1);
      if (references.length) {
        // Live built-in: deprecate in place (never drop a key configured indexers depend on).
        const caps = (row.capabilities ?? {}) as Record<string, unknown>;
        await this.db.update(schema.indexerDefinition)
          .set({ capabilities: { ...caps, cardigannStatus: { supported: false, reasons: ["removed upstream"] }, upstreamRemoved: true } })
          .where(eq(schema.indexerDefinition.id, row.id));
        summary.deprecated++;
      } else {
        // Orphaned with no referencing indexer — safe to remove.
        await this.db.delete(schema.indexerDefinition).where(eq(schema.indexerDefinition.id, row.id));
        summary.removedOrphaned++;
      }
    }
  }
}
