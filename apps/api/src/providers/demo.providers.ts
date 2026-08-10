// SPDX-License-Identifier: MIT
import { Global, Module } from "@nestjs/common";
import { MemoryIndexerProvider, MemoryDownloadClientProvider, ProviderRegistry } from "@medianexus/integrations";

export const MEMORY_INDEXER = Symbol("MEMORY_INDEXER");
export const MEMORY_DOWNLOAD_CLIENT = Symbol("MEMORY_DOWNLOAD_CLIENT");
export const PROVIDER_REGISTRY = Symbol("PROVIDER_REGISTRY");

/**
 * Demo provider instances. These prove the integration contracts end-to-end with
 * no network dependency; M1 replaces/augments them with real Newznab/Torznab and
 * SABnzbd/qBittorrent providers (which register in the same registry).
 */
@Global()
@Module({
  providers: [
    { provide: PROVIDER_REGISTRY, useFactory: () => new ProviderRegistry() },
    { provide: MEMORY_INDEXER, useFactory: (reg: ProviderRegistry) => {
        const p = new MemoryIndexerProvider();
        reg.register("indexer", p);
        return p;
      }, inject: [PROVIDER_REGISTRY] },
    { provide: MEMORY_DOWNLOAD_CLIENT, useFactory: (reg: ProviderRegistry) => {
        const p = new MemoryDownloadClientProvider();
        reg.register("downloadClient", p);
        return p;
      }, inject: [PROVIDER_REGISTRY] },
  ],
  exports: [MEMORY_INDEXER, MEMORY_DOWNLOAD_CLIENT, PROVIDER_REGISTRY],
})
export class DemoProvidersModule {}
