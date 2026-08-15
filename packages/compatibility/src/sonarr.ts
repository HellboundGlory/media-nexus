// SPDX-License-Identifier: MIT
/**
 * Sonarr v3-compatible surface builder.
 * Translates the native domain (via a narrow `source` facade) into the Sonarr wire
 * shapes the ecosystem depends on. No Sonarr source is copied — shapes derive from
 * Sonarr's published OpenAPI (functional interop).
 */
import { createSurface, type CompatRoute } from "./types";
import { json } from "./endpoints";
import type { CompatSeries, CompatEpisode, CompatQualityProfile } from "./wire-shapes";

export interface SonarrNativeSource {
  appVersion(): string;
  appName(): string;
  started(): string;
  databaseVersion(): string;
  listSeries(): Promise<CompatSeries[]>;
  getSeries(id: string): Promise<CompatSeries | null>;
  addSeries(input: Record<string, unknown>): Promise<CompatSeries>;
  updateSeries(id: string, input: Record<string, unknown>): Promise<CompatSeries | null>;
  removeSeries(id: string): Promise<void>;
  qualityProfiles(): Promise<CompatQualityProfile[]>;
  episodes(seriesId: string, season?: number): Promise<CompatEpisode[]>;
  /** Bulk episode monitoring (`PUT /episode/monitor`), Sonarr's real write shape. */
  updateEpisodesMonitor(seriesId: string, episodeIds: string[], monitored: boolean): Promise<void>;
  runCommand(name: string, body: Record<string, unknown>): Promise<{ id: string; name: string }>;
}

function seriesRoutes(s: SonarrNativeSource): CompatRoute[] {
  const status: CompatRoute = {
    method: "GET", path: "/system/status",
    handler: async () => json({
      appName: "MediaNexus", version: s.appVersion(), appVersion: s.appVersion(),
      isMono: false, isWindows: false, isLinux: true, isOsx: false, isDocker: true,
      startupPath: "/data/config", started: s.started(), databaseVersion: s.databaseVersion(),
      branch: "develop", authentication: "ApiKey",
    }),
  };
  const list: CompatRoute = {
    method: "GET", path: "/series",
    handler: async () => json(await s.listSeries()),
  };
  const get: CompatRoute = {
    method: "GET", path: "/series/:id",
    handler: async (ctx) => {
      const row = await s.getSeries(ctx.params.id);
      return row ? json(row) : json({ message: "Not Found" }, 404);
    },
  };
  const add: CompatRoute = {
    method: "POST", path: "/series",
    handler: async (ctx) => json(await s.addSeries(ctx.body as Record<string, unknown>), 201),
  };
  const update: CompatRoute = {
    method: "PUT", path: "/series/:id",
    handler: async (ctx) => {
      const row = await s.updateSeries(ctx.params.id, ctx.body as Record<string, unknown>);
      return row ? json(row) : json({ message: "Not Found" }, 404);
    },
  };
  const del: CompatRoute = {
    method: "DELETE", path: "/series/:id",
    handler: async (ctx) => { await s.removeSeries(ctx.params.id); return json(null, 200); },
  };
  const qp: CompatRoute = {
    method: "GET", path: "/qualityprofile",
    handler: async () => json(await s.qualityProfiles()),
  };
  const episodes: CompatRoute = {
    method: "GET", path: "/episode",
    handler: async (ctx) => {
      const sid = String(ctx.query.seriesId ?? "");
      const season = ctx.query.seasonNumber ? Number(ctx.query.seasonNumber) : undefined;
      if (!sid) return json({ message: "seriesId required" }, 400);
      return json(await s.episodes(sid, season));
    },
  };
  const monitorEpisodes: CompatRoute = {
    method: "PUT", path: "/episode/monitor",
    handler: async (ctx) => {
      const body = (ctx.body ?? {}) as { seriesId?: string | number; episodeIds?: Array<string | number>; monitored?: boolean };
      if (body.seriesId === undefined || !Array.isArray(body.episodeIds)) {
        return json({ message: "seriesId and episodeIds required" }, 400);
      }
      await s.updateEpisodesMonitor(String(body.seriesId), body.episodeIds.map(String), Boolean(body.monitored));
      return json(null, 200);
    },
  };
  const command: CompatRoute = {
    method: "POST", path: "/command",
    handler: async (ctx) => {
      const body = (ctx.body ?? {}) as { name?: string };
      if (!body.name) return json({ message: "command name required" }, 400);
      return json(await s.runCommand(body.name, body), 201);
    },
  };
  return [status, list, get, add, update, del, qp, episodes, monitorEpisodes, command];
}

export function buildSonarrV3SurfaceSource(s: SonarrNativeSource) {
  return createSurface({ name: "sonarr-v3", basePath: "/api/sonarr/v3", routes: seriesRoutes(s) });
}

// keep the existing status-only helper name compatible for any importers
export { seriesRoutes };
