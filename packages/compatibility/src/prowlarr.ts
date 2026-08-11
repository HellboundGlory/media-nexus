// SPDX-License-Identifier: MIT
/**
 * Prowlarr v1-compatible surface: system/status, configured indexers, and the
 * indexer search proxy — the surface Sonarr/Radarr talk to when MediaNexus is their
 * "Prowlarr". This is the core of indexer-sync/search interop for M6.
 */
import { createSurface, type CompatRoute, type CompatContext } from "./types";
import { json } from "./endpoints";
import type { CompatIndexerDef, CompatSearchResult } from "./wire-shapes";

export interface ProwlarrNativeSource {
  appVersion(): string; appName(): string; started(): string; databaseVersion(): string;
  listIndexers(): Promise<CompatIndexerDef[]>;
  /** search across configured indexers for a query; returns normalized results */
  search(query: string, categories?: number[]): Promise<CompatSearchResult[]>;
}

function routes(s: ProwlarrNativeSource): CompatRoute[] {
  const status: CompatRoute = {
    method: "GET", path: "/system/status",
    handler: async () => json({
      appName: "MediaNexus", version: s.appVersion(), appVersion: s.appVersion(),
      started: s.started(), databaseVersion: s.databaseVersion(), branch: "develop",
      authentication: "ApiKey",
    }),
  };
  const indexers: CompatRoute = {
    method: "GET", path: "/indexer",
    handler: async () => json(await s.listIndexers()),
  };
  const search: CompatRoute = {
    method: "GET", path: "/indexer/:id/search",
    handler: async (ctx: CompatContext) => {
      const query = String(ctx.query.query ?? "");
      if (!query) return json([], 200);
      const results = await s.search(query);
      const mine = results.filter((r) => String(r.indexerId) === ctx.params.id || r.indexerId === "0");
      return json(mine.length ? mine : results, 200);
    },
  };
  const genericSearch: CompatRoute = {
    method: "GET", path: "/search",
    handler: async (ctx: CompatContext) => json(await s.search(String(ctx.query.query ?? ""), cats(ctx))),
  };
  return [status, indexers, search, genericSearch];
}

function cats(ctx: CompatContext): number[] | undefined {
  const c = ctx.query.cat;
  if (!c) return undefined;
  return String(c).split(",").map(Number).filter((n) => Number.isInteger(n));
}

export function buildProwlarrV1Surface(s: ProwlarrNativeSource) {
  return createSurface({ name: "prowlarr-v1", basePath: "/api/prowlarr/v1", routes: routes(s) });
}
