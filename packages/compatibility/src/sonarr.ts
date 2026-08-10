// SPDX-License-Identifier: MIT
/**
 * First, deliberately-small compatibility slice: the Sonarr-compatible `system/status` read.
 * Proves the translation pattern (compat wire shape → native domain) with a contract test.
 * Full Sonarr surface is milestone M6.
 */
import { createSurface, type CompatRoute, type CompatContext } from "./types";
import { json, notImplemented } from "./endpoints";

export interface NativeStatusSource {
  appVersion(): string;
  appName(): string;
  started(): string;
  databaseVersion(): string;
}

export function sonarrStatusAdapter(source: NativeStatusSource): CompatRoute {
  return {
    method: "GET",
    path: "/system/status",
    description: "Sonarr v3-compatible /api/v3/system/status",
    handler: async (_ctx: CompatContext) =>
      json({
        appName: "MediaNexus",
        version: source.appVersion(),
        appVersion: source.appVersion(),
        isMono: false,
        isWindows: false,
        isLinux: true,
        isOsx: false,
        isDocker: true,
        startupPath: "/data/config",
        started: source.started(),
        databaseVersion: source.databaseVersion(),
        branch: "develop",
        authentication: "ApiKey",
      }),
  };
}

// Stub surface for the rest of the Sonarr v3 read/write surface — explicit 501s.
const pendingRoutes: CompatRoute[] = [
  ["GET", "/series"],
  ["GET", "/series/:id"],
  ["POST", "/series"],
  ["GET", "/episode"],
  ["GET", "/episodefile"],
  ["GET", "/qualityprofile"],
  ["GET", "/command"],
  ["POST", "/command"],
  ["GET", "/queue"],
  ["GET", "/history"],
  ["GET", "/wanted/missing"],
  ["GET", "/calendar"],
  ["GET", "/health"],
].map(([method, path]) => ({
  method: method as CompatRoute["method"],
  path,
  handler: notImplemented(`sonarr v3 ${method} ${path}`),
}));

export function buildSonarrV3Surface(source: NativeStatusSource) {
  const routes: CompatRoute[] = [sonarrStatusAdapter(source), ...pendingRoutes];
  return createSurface({ name: "sonarr-v3", basePath: "/api/sonarr/v3", routes });
}
