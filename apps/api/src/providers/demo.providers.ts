
// SPDX-License-Identifier: MIT
import { Global, Inject, Injectable, Module } from "@nestjs/common";
import { eq } from "drizzle-orm";
import {
  buildFetcher,
  CardigannProvider,
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
import { tagApplies } from "../common/tags";
import { ApiError } from "@medianexus/shared";
import { DB_TOKEN } from "../db/database.module";
import { ConfigService } from "../system/config.service";
import { ProviderStatusService } from "./provider-status.service";
import { parseCardigannYaml } from "@medianexus/integrations";
import {
  DOWNLOAD_CLIENT_SECRET_FIELDS,
  INDEXER_SETTINGS_SECRET_FIELDS,
  PROXY_SECRET_FIELDS,
  cardigannSecretFields,
  decryptFields,
  getProviderSecret,
} from "../secrets/provider-secrets";

export const MEMORY_INDEXER = Symbol("MEMORY_INDEXER");
export const MEMORY_DOWNLOAD_CLIENT = Symbol("MEMORY_DOWNLOAD_CLIENT");
export const PROVIDER_REGISTRY = Symbol("PROVIDER_REGISTRY");

/**
 * Provider instances + registry. The in-memory indexer/download-client providers are
 * registered for test infrastructure only (never surfaced to a real client — see
 * IndexersService.definitions() and the lack of any implicit fallback in
 * configuredDownloadClients()/pickDownloadClient()); real providers (newznab/torznab,
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
    private readonly config: ConfigService,
    private readonly status: ProviderStatusService,
  ) {}

  async configuredIndexers(): Promise<ConfiguredIndexer[]> {
    const rows = await this.db.select().from(schema.indexer).where(eq(schema.indexer.enabled, true));
    const flare = (await this.config.get())["discovery.flareSolverrBaseUrl"] || undefined;
    const secret = getProviderSecret();
    const out: ConfiguredIndexer[] = [];
    for (const row of rows) {
      const def = row.implementation === "cardigann"
        ? (await this.db.select().from(schema.indexerDefinition).where(eq(schema.indexerDefinition.key, row.definitionKey)).limit(1))[0]
        : undefined;
      // J9: decrypt stored credentials before building a provider — tolerant, so a row
      // that is still plaintext (e.g. mid-run upstream import) still works.
      const secretFields = row.implementation === "cardigann"
        ? cardigannSecretFields(def?.cardigannYml ? parseCardigannYaml(def.cardigannYml) : undefined)
        : (INDEXER_SETTINGS_SECRET_FIELDS[row.implementation] ?? []);
      const settings = decryptFields((row.settings ?? {}) as Record<string, unknown>, secretFields, secret);
      const rawProxy = row.proxy as { type?: string; host?: string; port?: number; username?: string; password?: string; enabled?: boolean; flareSolverr?: boolean } | null;
      const proxy = rawProxy ? decryptFields(rawProxy, PROXY_SECRET_FIELDS, secret) as typeof rawProxy : rawProxy;
      const fetcher = buildFetcher({
        proxy: (proxy ? { enabled: proxy.enabled ?? true, type: proxy.type as never, host: proxy.host as string, port: proxy.port ?? 0, username: proxy.username, password: proxy.password } : null) as never,
        flareSolverrUrl: proxy?.flareSolverr && flare ? flare : undefined,
      });
      if (row.implementation === "memory") {
        out.push({ row, provider: this.memIdx });
      } else if (row.implementation === "newznab" || row.implementation === "torznab") {
        out.push({
          row,
          provider: new NewznabProvider(row.id, row.protocol as "usenet" | "torrent", settings as never, fetcher as never),
        });
      } else if (row.implementation === "cardigann") {
        const yml = def?.cardigannYml;
        if (!yml) continue;
        out.push({
          row,
          provider: new CardigannProvider({
            key: row.id,
            protocol: row.protocol as "usenet" | "torrent",
            definitionText: yml,
            settings: settings as Record<string, never>,
            fetcher: fetcher as never,
          }),
        });
      }
    }
    return out;
  }

  async configuredDownloadClients(): Promise<ConfiguredClient[]> {
    const rows = await this.db.select().from(schema.downloadClient).where(eq(schema.downloadClient.enabled, true));
    const secret = getProviderSecret();
    const out: ConfiguredClient[] = [];
    for (const row of rows) {
      // J9: decrypt stored credentials before building a provider (tolerant to plaintext).
      const settings = decryptFields((row.settings ?? {}) as Record<string, unknown>, DOWNLOAD_CLIENT_SECRET_FIELDS[row.implementation] ?? [], secret);
      if (row.implementation === "sabnzbd") out.push({ row, provider: new SabnzbdProvider(settings as never) });
      else if (row.implementation === "qbittorrent") out.push({ row, provider: new QbittorrentProvider(settings as never) });
      else if (row.implementation === "memory") out.push({ row, provider: this.memClient });
    }
    return out;
  }

  /** Pick the best download client for a release protocol (usenet|torrent). Clients that
   *  are backed off / auto-disabled (B10) are skipped from automatic selection so grabs
   *  don't land on a dead client; an explicit `downloadClientId` is honored verbatim
   *  (explicit/manual override must still be able to reach a recovery path). When
   *  `mediaTags` is given, only tag-eligible clients are considered (roadmap P2, gap C6):
   *  an untagged client serves anything; a tagged client only serves media sharing a tag. */
  async pickDownloadClient(
    protocol: "usenet" | "torrent",
    explicitId?: string,
    mediaTags?: string[],
  ): Promise<ConfiguredClient> {
    const clients = await this.configuredDownloadClients();
    if (explicitId) {
      const hit = clients.find((c) => c.row?.id === explicitId);
      if (hit) return hit;
    }
    const matches = clients
      .filter((c) => c.row && c.row.kind === protocol)
      .filter((c) => tagApplies(c.row?.tags, mediaTags));
    const viable: ConfiguredClient[] = [];
    for (const c of matches) {
      if (c.row && await this.status.isSkipped("downloadClient", c.row.id)) continue;
      viable.push(c);
    }
    viable.sort((a, b) => (a.row?.priority ?? 1) - (b.row?.priority ?? 1));
    if (!viable[0]) throw new ApiError({ code: "UNPROCESSABLE", message: `No enabled ${protocol} download client is configured` });
    return viable[0];
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
    ProviderStatusService,
  ],
  exports: [MEMORY_INDEXER, MEMORY_DOWNLOAD_CLIENT, PROVIDER_REGISTRY, ProvidersService, ProviderStatusService],
})
export class DemoProvidersModule {}
