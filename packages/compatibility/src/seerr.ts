// SPDX-License-Identifier: MIT
/**
 * Seerr/Overseerr v1-compatible surface builder.
 * Translated from native services into the Seerr wire shapes (documented Overseerr
 * public API is the interop reference; no source copied).
 */
import { createSurface, type CompatRoute, type CompatContext } from "./types";
import { json } from "./endpoints";

// ---- Seerr wire shapes ----
export interface SeerrSettingsPublic {
  initialized: boolean;
  onboarding: boolean;
  locale: string;
  region: string;
  originalLanguage: string;
  appName: string;
  url: string;
  emailEnabled: boolean;
}

export interface SeerrUser {
  id: string;
  email: string | null;
  username: string;
  permissions: number;
  requestCount: number;
  avatar: string;
  token?: string;
}

export interface SeerrPageInfo {
  page: number;
  totalPages: number;
  totalResults: number;
  resultsPerPage: number;
}

export interface SeerrTitle {
  id: string;
  title: string;
  mediaType: "movie" | "tv";
  tmdbId?: number | null;
  status?: string;
  year?: number | null;
  overview?: string;
  releases?: unknown[];
  mediaInfo?: unknown;
}

export interface SeerrRequest {
  id: string;
  mediaId: string;
  mediaType: "movie" | "tv";
  status: number;
  createdAt: string;
  updatedAt: string;
  requestedBy?: SeerrUser;
}

/** our request status -> Seerr status code (Overseerr enum) */
export function seerrStatus(status: string): number {
  switch (status) {
    case "pending": return 1;
    case "approved": return 2;
    case "declined": return 3;
    case "processing": return 4;
    case "failed": return 5;
    case "fulfilled": return 6;
    default: return 1;
  }
}

export interface SeerrNativeSource {
  version(): string;
  commitTag(): string;
  totals(): Promise<{ requests: number; movies: number; tv: number }>;
  settingsPublic(): Promise<SeerrSettingsPublic>;
  /** login with username/email + password; returns the user + an api token (rides on native API keys) */
  login(identifier: string, password: string): Promise<SeerrUser | null>;
  /** resolve the user for a token */
  me(token: string): Promise<SeerrUser | null>;
  logout(token: string): Promise<void>;
  listRequests(page: number, take: number): Promise<{ items: SeerrRequest[]; total: number }>;
  createRequest(mediaType: "movie" | "tv", mediaId: string, token: string): Promise<SeerrRequest>;
  media(tmdbId: string): Promise<SeerrTitle | null>;
  discover(mediaType: "movie" | "tv", page?: number): Promise<SeerrTitle[]>;
  search(query: string): Promise<SeerrTitle[]>;
}

function ofUser(u: SeerrUser, includeToken = false): SeerrUser {
  const out = { id: u.id, email: u.email, username: u.username, permissions: u.permissions, requestCount: u.requestCount, avatar: u.avatar };
  return includeToken && u.token ? { ...out, token: u.token } : out;
}

function routes(s: SeerrNativeSource): CompatRoute[] {
  const bearerKey = (ctx: CompatContext): string => {
    const raw = ctx.headers?.["x-api-key"] ?? ctx.headers?.["authorization"] ?? "";
    return String(raw).split("Bearer ").pop()?.trim() ?? String(ctx.query["api_key"] ?? "");
  };

  const status: CompatRoute = {
    method: "GET", path: "/status",
    handler: async () => {
      const t = await s.totals();
      return json({ version: s.version(), commitTag: s.commitTag(), totalRequests: t.requests, totalMovies: t.movies, totalTv: t.tv });
    },
  };
  const authLocal: CompatRoute = {
    method: "POST", path: "/auth/local",
    handler: async (ctx) => {
      const b = (ctx.body ?? {}) as { email?: string; username?: string; password?: string };
      const user = await s.login(b.username ?? b.email ?? "", b.password ?? "");
      return user ? json(ofUser(user, true), 200) : json({ message: "Invalid credentials" }, 401);
    },
  };
  const authMe: CompatRoute = {
    method: "GET", path: "/auth/me",
    handler: async (ctx) => {
      const user = await s.me(bearerKey(ctx));
      return user ? json(ofUser(user), 200) : json({ message: "Unauthorized" }, 401);
    },
  };
  const authLogout: CompatRoute = {
    method: "POST", path: "/auth/logout",
    handler: async (ctx) => { await s.logout(bearerKey(ctx)); return json(null, 200); },
  };
  const settings: CompatRoute = {
    method: "GET", path: "/settings/public",
    handler: async () => json(await s.settingsPublic()),
  };
  const listRequests: CompatRoute = {
    method: "GET", path: "/request",
    handler: async (ctx) => {
      const page = Number(ctx.query.page ?? 1);
      const take = Number(ctx.query.take ?? 20);
      const { items, total } = await s.listRequests(page, take);
      return json({
        pageInfo: { page, totalPages: Math.max(1, Math.ceil(total / take)), totalResults: total, resultsPerPage: take } satisfies SeerrPageInfo,
        results: items,
      });
    },
  };
  const createRequest: CompatRoute = {
    method: "POST", path: "/request",
    handler: async (ctx) => {
      const b = (ctx.body ?? {}) as { mediaType?: string; mediaId?: string };
      const mt = b.mediaType === "tv" ? "tv" : "movie";
      if (!b.mediaId) return json({ message: "mediaId required" }, 400);
      return json(await s.createRequest(mt as "movie" | "tv", String(b.mediaId), bearerKey(ctx)), 201);
    },
  };
  const media: CompatRoute = {
    method: "GET", path: "/media/:tmdbId",
    handler: async (ctx) => {
      const row = await s.media(ctx.params.tmdbId);
      return row ? json(row) : json({ message: "Not Found" }, 404);
    },
  };
  const discoverMovies: CompatRoute = {
    method: "GET", path: "/discover/movies",
    handler: async (ctx) => json(await s.discover("movie", ctx.query.page ? Number(ctx.query.page) : 1)),
  };
  const discoverTv: CompatRoute = {
    method: "GET", path: "/discover/tv",
    handler: async (ctx) => json(await s.discover("tv", ctx.query.page ? Number(ctx.query.page) : 1)),
  };
  const search: CompatRoute = {
    method: "GET", path: "/search",
    handler: async (ctx) => json(await s.search(String(ctx.query.query ?? ""))),
  };
  return [status, authLocal, authMe, authLogout, settings, listRequests, createRequest, media, discoverMovies, discoverTv, search];
}

export function buildSeerrV1Surface(s: SeerrNativeSource) {
  return createSurface({ name: "seerr-v1", basePath: "/api/seerr/v1", routes: routes(s) });
}
