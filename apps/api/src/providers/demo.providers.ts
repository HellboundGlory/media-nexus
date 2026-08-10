
// SPDX-License-Identifier: MIT
import { Global, Inject, Injectable, Module } from "@nestjs/common";
import { eq } from "drizzle-orm";
import {
  MemoryIndexerProvider,
  MemoryDownloadClientProvider,
  NewznabProvider,
  ProviderRegistry,
  QbittorrentProvider,
  SabnzbdProvider,
  type DownloadClientContract,
  type IndexerContract,
} from "@medianexus/integrations";
import { schema, type Db } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";

export const MEMORY_INDEXER = Symbol("MEMORY_INDEXER");
export const MEMORY_DOWNLOAD_CLIENT = Symbol("MEMORY_DOWNLOAD_CLIENT");
export const PROVIDER_REGISTRY = Symbol("PROVIDER_REGISTRY");

/**
 * Provider instances + registry. The in-memory demo providers are registered so the
 * demo flow keeps working with zero external services; real providers (newznab/torznab,
 * sabnzbd, qbittorrent) are materialized from DB configuration on demand by ProvidersService.
 */

export type ConfiguredIndexer = { row: (typeof schema.indexer.$inferSelect); provider: IndexerContract };
export type ConfiguredClient = { row: (typeof schema.downloadClient.$inferSelect) | null; provider: DownloadClientContract };

/**
 * Builds live provider instances from DB configuration. Search, grabs and the download
 * monitor all go through here so core code never constructs vendor-specific clients.
 */
@Injectable()
export class ProvidersService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    @Inject(PROVIDER_REGISTRY) private readonly registry: ProviderRegistry,
    @Inject(MEMORY_INDEXER) private readonly memIdx: MemoryIndexerProvider,
    @Inject(MEMORY_DOWNLOAD_CLIENT) private readonly memClient: MemoryDownloadClientProvider,
  ) {}

  async configuredIndexers(): Promise<ConfiguredIndexer[]> {
    const rows = await this.db.select().from(schema.indexer).where(eq(schema.indexer.enabled, true));
    const out: ConfiguredIndexer[] = [];
    for (const row of rows) {
      const settings = (row.settings ?? {}) as Record<string, unknown>;
      if (row.implementation === "memory") {
        out.push({ row, provider: this.memIdx });
      } else if (row.implementation === "newznab" || row.implementation === "torznab") {
        out.push({
          row,
          provider: new NewznabProvider(row.id, row.protocol as "usenet" | "torrent", settings as never),
        });
      }
    }
    return out;
  }

  async configuredDownloadClients(): Promise<ConfiguredClient[]> {
    const rows = await this.db.select().from(schema.downloadClient).where(eq(schema.downloadClient.enabled, true));
    const out: ConfiguredClient[] = [];
    for (const row of rows) {
      const settings = (row.settings ?? {}) as Record<string, unknown>;
      if (row.implementation === "sabnzbd") out.push({ row, provider: new SabnzbdProvider(settings as never) });
      else if (row.implementation === "qbittorrent") out.push({ row, provider: new QbittorrentProvider(settings as never) });
      else if (row.implementation === "memory") out.push({ row, provider: this.memClient });
    }
    // the demo client is always available as a fallback (dev/demo flow)
    out.push({ row: null, provider: this.memClient });
    return out;
  }

  /** Pick the best download client for a release protocol (usenet|torrent). */
  async pickDownloadClient(
    protocol: "usenet" | "torrent",
    explicitId?: string,
  ): Promise<ConfiguredClient> {
    const clients = await this.configuredDownloadClients();
    if (explicitId) {
      const hit = clients.find((c) => c.row?.id === explicitId);
      if (hit) return hit;
    }
    const matches = clients.filter((c) => !c.row || c.row.kind === protocol);
    matches.sort((a, b) => (a.row?.priority ?? 1) - (b.row?.priority ?? 1));
    return matches[0] ?? { row: null, provider: this.memClient };
  }

  getRegistry(): ProviderRegistry {
    return this.registry;
  }
}

@Global()
@Module({
  providers: [
    { provide: PROVIDER_REGISTRY, useFactory: () => new ProviderRegistry() },
    {
      provide: MEMORY_INDEXER,
      useFactory: (reg: ProviderRegistry) => {
        const p = new MemoryIndexerProvider();
        reg.register("indexer", p);
        return p;
      },
      inject: [PROVIDER_REGISTRY],
    },
    {
      provide: MEMORY_DOWNLOAD_CLIENT,
      useFactory: (reg: ProviderRegistry) => {
        const p = new MemoryDownloadClientProvider();
        reg.register("downloadClient", p);
        return p;
      },
      inject: [PROVIDER_REGISTRY],
    },
    ProvidersService,
  ],
  exports: [MEMORY_INDEXER, MEMORY_DOWNLOAD_CLIENT, PROVIDER_REGISTRY, ProvidersService],
})
export class DemoProvidersModule {}
