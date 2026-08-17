
// SPDX-License-Identifier: MIT
import { Global, Inject, Injectable, Logger, Module } from "@nestjs/common";
import { eq } from "drizzle-orm";
import {
  buildFetcher,
  CardigannProvider,
  MemoryIndexerProvider,
  MemoryDownloadClientProvider,
  NewznabProvider,
  NzbgetProvider,
  ProviderRegistry,
  QbittorrentProvider,
  SabnzbdProvider,
  TransmissionProvider,
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
  decryptSessionValue,
  getProviderSecret,
} from "../secrets/provider-secrets";

const MEMORY_INDEXER = Symbol("MEMORY_INDEXER");
export const MEMORY_DOWNLOAD_CLIENT = Symbol("MEMORY_DOWNLOAD_CLIENT");
const PROVIDER_REGISTRY = Symbol("PROVIDER_REGISTRY");

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
  private readonly logger = new Logger(ProvidersService.name);
  /** Download-client instances cached by row id so a provider keeps its session state
   *  (e.g. qBittorrent's SID cookie, Transmission's session-id) across polls — the
   *  session-reuse fix (gap report J5 / D3). Rebuilt only when the row's config changes
   *  (fingerprint mismatch) or on explicit invalidation. */
  private readonly clientCache = new Map<string, ConfiguredClient>();
  private readonly clientFingerprints = new Map<string, string>();

  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    @Inject(PROVIDER_REGISTRY) private readonly registry: ProviderRegistry,
    @Inject(MEMORY_INDEXER) private readonly memIdx: MemoryIndexerProvider,
    @Inject(MEMORY_DOWNLOAD_CLIENT) private readonly memClient: MemoryDownloadClientProvider,
    private readonly config: ConfigService,
    private readonly status: ProviderStatusService,
  ) {}

  /** Fingerprint of everything on a download-client row that affects its provider —
   *  settings, enabled, priority, kind, tags, name. A fingerprint miss means the config
   *  changed and the provider must be rebuilt (e.g. a new credential or path). */
  private fingerprintDownloadClient(row: (typeof schema.downloadClient.$inferSelect)): string {
    return JSON.stringify({
      settings: row.settings, enabled: row.enabled, priority: row.priority,
      kind: row.kind, tags: row.tags, name: row.name,
    });
  }

  /** Drop the cached provider for a client (on create/update/remove) so the next call
   *  rebuilds it from fresh config. */
  invalidateDownloadClient(id: string): void {
    this.clientCache.delete(id);
    this.clientFingerprints.delete(id);
  }

  /**
   * Build an indexer provider from a row-shaped object with ALREADY-DECRYPTED plaintext settings.
   * This is the single construction path shared by configuredIndexers() and the draft test endpoint.
   * Must NOT touch clientCache/clientFingerprints and must NOT filter on enabled.
   * THROWS when the row cannot be materialized (e.g. a cardigann definition with no YAML body, or
   * a definition row that was pruned) — callers on a hot path must catch and skip the row.
   * `flareSolverrUrl` is resolved by the caller once (it reads config), not per row.
   */
  async buildIndexerProvider(row: {
    id: string;
    definitionKey: string;
    protocol: "usenet" | "torrent";
    implementation: string;
    settings: Record<string, unknown>;
    proxy: { type?: string; host?: string; port?: number; username?: string; password?: string; enabled?: boolean; flareSolverr?: boolean } | null;
    sessionState?: string | null;
  }, flareSolverrUrl?: string): Promise<IndexerContract> {
    const def = row.implementation === "cardigann"
      ? (await this.db.select().from(schema.indexerDefinition).where(eq(schema.indexerDefinition.key, row.definitionKey)).limit(1))[0]
      : undefined;

    const rawProxy = row.proxy;
    // enabled default here MUST agree with indexerProxySchema (default false) — the stored row is
    // written from the parsed schema output, so a missing flag means disabled, never enabled.
    const fetcher = buildFetcher({
      proxy: (rawProxy ? { enabled: rawProxy.enabled ?? false, type: rawProxy.type as never, host: rawProxy.host as string, port: rawProxy.port ?? 0, username: rawProxy.username, password: rawProxy.password } : null) as never,
      flareSolverrUrl: rawProxy?.flareSolverr && flareSolverrUrl ? flareSolverrUrl : undefined,
    });

    if (row.implementation === "memory") {
      return this.memIdx;
    } else if (row.implementation === "newznab" || row.implementation === "torznab") {
      return new NewznabProvider(row.id, row.protocol, row.settings as never, fetcher as never);
    } else if (row.implementation === "cardigann") {
      const yml = def?.cardigannYml;
      if (!yml) throw new ApiError({ code: "VALIDATION_ERROR", message: "Cardigann definition has no YAML body" });
      return new CardigannProvider({
        key: row.id,
        protocol: row.protocol,
        definitionText: yml,
        settings: row.settings as Record<string, never>,
        fetcher: fetcher as never,
        sessionState: row.sessionState ? decryptSessionValue(row.sessionState, getProviderSecret()) ?? undefined : undefined,
      });
    }
    throw new ApiError({ code: "VALIDATION_ERROR", message: `Unknown indexer implementation: ${row.implementation}` });
  }

  /**
   * Build a download client provider from a row-shaped object with ALREADY-DECRYPTED plaintext settings.
   * This is the single construction path shared by configuredDownloadClients() and the draft test endpoint.
   * Must NOT touch clientCache/clientFingerprints and must NOT filter on enabled.
   * THROWS when the implementation is unknown — callers on a hot path must catch and skip the row.
   */
  buildDownloadClientProvider(row: {
    implementation: string;
    settings: Record<string, unknown>;
  }): DownloadClientContract {
    if (row.implementation === "sabnzbd") return new SabnzbdProvider(row.settings as never);
    if (row.implementation === "qbittorrent") return new QbittorrentProvider(row.settings as never);
    if (row.implementation === "transmission") return new TransmissionProvider(row.settings as never);
    if (row.implementation === "nzbget") return new NzbgetProvider(row.settings as never);
    if (row.implementation === "memory") return this.memClient;
    throw new ApiError({ code: "VALIDATION_ERROR", message: `Unknown download client implementation: ${row.implementation}` });
  }

  async configuredIndexers(): Promise<ConfiguredIndexer[]> {
    const rows = await this.db.select().from(schema.indexer).where(eq(schema.indexer.enabled, true));
    const secret = getProviderSecret();
    // Resolve once, hoisted above the loop — ConfigService.get() is uncached and this is a hot path
    // (every search / RSS poll), so it must not run once per indexer row.
    const flare = (await this.config.get())["discovery.flareSolverrBaseUrl"] || undefined;
    const out: ConfiguredIndexer[] = [];
    for (const row of rows) {
      // J9: decrypt stored credentials before building a provider — tolerant, so a row
      // that is still plaintext (e.g. mid-run upstream import) still works.
      const def = row.implementation === "cardigann"
        ? (await this.db.select().from(schema.indexerDefinition).where(eq(schema.indexerDefinition.key, row.definitionKey)).limit(1))[0]
        : undefined;
      const secretFields = row.implementation === "cardigann"
        ? cardigannSecretFields(def?.cardigannYml ? parseCardigannYaml(def.cardigannYml) : undefined)
        : (INDEXER_SETTINGS_SECRET_FIELDS[row.implementation] ?? []);
      const settings = decryptFields((row.settings ?? {}) as Record<string, unknown>, secretFields, secret);
      const rawProxy = row.proxy as { type?: string; host?: string; port?: number; username?: string; password?: string; enabled?: boolean; flareSolverr?: boolean } | null;
      const proxy = rawProxy ? decryptFields(rawProxy, PROXY_SECRET_FIELDS, secret) as typeof rawProxy : rawProxy;
      // One unbuildable row (e.g. a cardigann definition pruned by cardigann-sync) must never take
      // down the whole list — skip it and keep the rest, matching the original `continue`.
      let provider: IndexerContract;
      try {
        provider = await this.buildIndexerProvider({
          id: row.id,
          definitionKey: row.definitionKey,
          protocol: row.protocol as "usenet" | "torrent",
          implementation: row.implementation,
          settings,
          proxy,
          sessionState: row.sessionState ?? undefined,
        }, flare);
      } catch (err) {
        this.logger.warn(`skipping unbuildable indexer "${row.name}" (${row.id}): ${(err as Error).message}`);
        continue;
      }
      out.push({ row, provider });
    }
    return out;
  }

  async configuredDownloadClients(): Promise<ConfiguredClient[]> {
    const rows = await this.db.select().from(schema.downloadClient).where(eq(schema.downloadClient.enabled, true));
    const secret = getProviderSecret();
    const out: ConfiguredClient[] = [];
    for (const row of rows) {
      // Session-reuse (J5/D3): reuse the cached provider when the row's config is unchanged,
      // so instance state (qBittorrent SID cookie, Transmission session-id) survives a poll.
      const fingerprint = this.fingerprintDownloadClient(row);
      const cached = this.clientCache.get(row.id);
      if (cached && this.clientFingerprints.get(row.id) === fingerprint) {
        out.push(cached);
        continue;
      }
      // J9: decrypt stored credentials before building a provider (tolerant to plaintext).
      const settings = decryptFields((row.settings ?? {}) as Record<string, unknown>, DOWNLOAD_CLIENT_SECRET_FIELDS[row.implementation] ?? [], secret);
      // One unknown implementation must not take down configuredDownloadClients() (which feeds
      // pickDownloadClient() and therefore every grab) — skip it, matching the original `continue`.
      let provider: DownloadClientContract;
      try {
        provider = this.buildDownloadClientProvider({ implementation: row.implementation, settings });
      } catch (err) {
        this.logger.warn(`skipping unbuildable download client "${row.name}" (${row.id}): ${(err as Error).message}`);
        continue;
      }
      const configured: ConfiguredClient = { row, provider };
      this.clientCache.set(row.id, configured);
      this.clientFingerprints.set(row.id, fingerprint);
      out.push(configured);
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
