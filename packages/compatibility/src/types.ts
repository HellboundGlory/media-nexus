// SPDX-License-Identifier: MIT
/** Framework-agnostic compatibility-layer primitives.
 *  Nest mounts each surfaced route; adapters translate wire formats to/from native domain calls. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface CompatContext {
  method: HttpMethod;
  path: string; // e.g. /api/sonarr/v3/series/{id}
  rawPath: string; // as requested
  params: Record<string, string>;
  query: Record<string, string | string[] | undefined>;
  headers: Record<string, string | undefined>;
  body: unknown;
  apiKey?: string;
}

export type CompatHandler = (ctx: CompatContext) => Promise<{ status: number; body: unknown }>;

export interface CompatRoute {
  method: HttpMethod;
  /** path patterns with `:param` segments, e.g. `/system/status` */
  path: string;
  handler: CompatHandler;
  /** endpoint-level description for docs */
  description?: string;
}

export function createSurface(opts: {
  name: string;
  basePath: string; // e.g. /api/sonarr/v3
  routes: CompatRoute[];
}): CompatSurface {
  return new CompatSurface(opts.name, opts.basePath, opts.routes);
}

export class CompatSurface {
  constructor(
    readonly name: string,
    readonly basePath: string,
    readonly routes: CompatRoute[],
  ) {}

  match(method: HttpMethod, pathWithBase: string): { route: CompatRoute; ctx: CompatContext } | null {
    const rel = pathWithBase.startsWith(this.basePath)
      ? pathWithBase.slice(this.basePath.length)
      : pathWithBase;
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const segs = rel.split("/").filter(Boolean);
      const pat = route.path.split("/").filter(Boolean);
      if (segs.length !== pat.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < pat.length; i++) {
        if (pat[i].startsWith(":")) params[pat[i].slice(1)] = decodeURIComponent(segs[i]);
        else if (pat[i] !== segs[i]) { ok = false; break; }
      }
      if (!ok) continue;
      const ctx: CompatContext = {
        method, path: route.path, rawPath: pathWithBase,
        params, query: {}, headers: {}, body: undefined,
      };
      return { route, ctx };
    }
    return null;
  }
}
