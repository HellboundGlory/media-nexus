// SPDX-License-Identifier: MIT
/** Radarr v3-compatible surface builder (native → Radarr wire shapes). */
import { createSurface, type CompatRoute, type CompatContext } from "./types";
import { json } from "./endpoints";
import type { CompatMovie, CompatQualityProfile } from "./wire-shapes";

export interface RadarrNativeSource {
  appVersion(): string; appName(): string; started(): string; databaseVersion(): string;
  listMovies(): Promise<CompatMovie[]>;
  getMovie(id: string): Promise<CompatMovie | null>;
  addMovie(input: Record<string, unknown>): Promise<CompatMovie>;
  removeMovie(id: string): Promise<void>;
  qualityProfiles(): Promise<CompatQualityProfile[]>;
  runCommand(name: string, body: Record<string, unknown>): Promise<{ id: string; name: string }>;
}

function routes(s: RadarrNativeSource): CompatRoute[] {
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
    method: "GET", path: "/movie",
    handler: async () => json(await s.listMovies()),
  };
  const get: CompatRoute = {
    method: "GET", path: "/movie/:id",
    handler: async (ctx: CompatContext) => {
      const row = await s.getMovie(ctx.params.id);
      return row ? json(row) : json({ message: "Not Found" }, 404);
    },
  };
  const add: CompatRoute = {
    method: "POST", path: "/movie",
    handler: async (ctx: CompatContext) => json(await s.addMovie(ctx.body as Record<string, unknown>), 201),
  };
  const del: CompatRoute = {
    method: "DELETE", path: "/movie/:id",
    handler: async (ctx: CompatContext) => { await s.removeMovie(ctx.params.id); return json(null, 200); },
  };
  const qp: CompatRoute = {
    method: "GET", path: "/qualityprofile",
    handler: async () => json(await s.qualityProfiles()),
  };
  const command: CompatRoute = {
    method: "POST", path: "/command",
    handler: async (ctx: CompatContext) => {
      const body = (ctx.body ?? {}) as { name?: string };
      if (!body.name) return json({ message: "command name required" }, 400);
      return json(await s.runCommand(body.name, body), 201);
    },
  };
  return [status, list, get, add, del, qp, command];
}

export function buildRadarrV3Surface(s: RadarrNativeSource) {
  return createSurface({ name: "radarr-v3", basePath: "/api/radarr/v3", routes: routes(s) });
}
