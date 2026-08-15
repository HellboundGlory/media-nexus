// SPDX-License-Identifier: MIT
/**
 * TheTVDB v4 metadata provider — numbering backfill for episode parsing (roadmap P2, gap D8).
 *
 * TVDB is the source that carries the fields TMDB does not expose for TV series:
 * `absoluteNumber`, and the DVD/scene ordering that maps onto our
 * `episode.absoluteNumber` / `episode.sceneSeasonNumber` / `episode.sceneEpisodeNumber`.
 * TVDB is *additive* to TMDB — it is used only to backfill those three numbering fields on
 * episode rows, never for discovery/search/overview/images (those stay TMDB).
 *
 * Note: deliberately does NOT implement `MetadataProviderContract` — that contract is for
 * TMDB-style discovery providers (search/getDetails). TvdbProvider is a numbering-only
 * backfill source exposing just `episodes()`.
 *
 * Two modes, mirroring the TmdbProvider shape:
 *  - shared-proxy (default): no `apiKey` → calls go to the MediaNexus Cloudflare proxy URL
 *    (which holds the key, exactly like Sonarr's `skyhook.sonarr.tv`). The proxy authenticates
 *    transparently, so the client performs no login.
 *  - BYO-key: an `apiKey` is supplied → base URL defaults to the real TVDB API and the client
 *    does its own login / bearer-token cache / 401 re-login retry.
 */
export const DEFAULT_TVDB_WORKER_URL = "https://medianexus-tvdb-proxy.hellboundg-e09.workers.dev";
const REAL_TVDB_API = "https://api4.thetvdb.com/v4";
const TOKEN_TTL_MS = 27 * 24 * 3600 * 1000; // refresh conservatively before TVDB's 1-month expiry

export interface TvdbSettings {
  baseUrl?: string;
  /** BYO-key mode: authenticated directly against the real TVDB API. */
  apiKey?: string;
}

export type TvdbSeasonType =
  | "default" | "official" | "dvd" | "absolute" | "alternate" | "regional";

/** A single episode in a given season-type's ordering. `number` is that ordering's
 *  episode number within `seasonNumber`; `absoluteNumber` is the episode's flat number. */
export interface TvdbEpisodeRecord {
  id: number;
  seasonNumber: number | null;
  number: number | null;
  absoluteNumber: number | null;
  /** ISO date (YYYY-MM-DD) — a robust secondary join key against local air dates. */
  aired: string | null;
}

interface RawEpisode {
  id?: number; seasonNumber?: number | null; number?: number | null;
  absoluteNumber?: number | null; aired?: string | null;
}
interface RawEpisodesPage {
  data?: { episodes?: RawEpisode[] };
  links?: { next?: string | null };
}

export class TvdbProvider {
  readonly key = "tvdb";
  /** Resolved base URL (exposed for introspection/tests); trailing slash stripped. */
  readonly baseUrl: string;
  private readonly apiKey?: string;
  private token?: string;
  private tokenValidUntil = 0;

  constructor(settings: TvdbSettings, private readonly fetchImpl: typeof fetch = fetch) {
    const defaultBase = settings.apiKey ? REAL_TVDB_API : DEFAULT_TVDB_WORKER_URL;
    this.baseUrl = (settings.baseUrl || defaultBase).replace(/\/$/, "");
    this.apiKey = settings.apiKey;
  }

  /** All episodes for a series under a season-type ordering, paged through every page. */
  async episodes(tvdbId: number, seasonType: TvdbSeasonType = "official"): Promise<TvdbEpisodeRecord[]> {
    const out: TvdbEpisodeRecord[] = [];
    let page = 0;
    for (;;) {
      const j = await this.get<RawEpisodesPage>(`/series/${tvdbId}/episodes/${seasonType}?page=${page}`);
      const eps = j?.data?.episodes ?? [];
      for (const e of eps) {
        out.push({
          id: e.id ?? 0,
          seasonNumber: e.seasonNumber ?? null,
          number: e.number ?? null,
          absoluteNumber: e.absoluteNumber ?? null,
          aired: e.aired ?? null,
        });
      }
      const next = j?.links?.next;
      if (!next || eps.length === 0) break;
      page++;
    }
    return out;
  }

  /** Alternate titles / abbreviations for a series (TVDB `aliases`), deduped. Used for
   *  scene/acronym title matching (roadmap P2, gap D8) — e.g. AOT/SNK for Attack on Titan. */
  async seriesAliases(tvdbId: number): Promise<string[]> {
    const j = await this.get<{ data?: { aliases?: Array<{ language?: string; name?: string }> } }>(`/series/${tvdbId}/extended`);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const a of j?.data?.aliases ?? []) {
      const name = a?.name?.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
    return out;
  }

  private async get<T>(path: string): Promise<T> {
    if (this.apiKey) {
      if (!this.token || Date.now() >= this.tokenValidUntil) await this.login();
      let res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (res.status === 401) {
        await this.login();
        res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          signal: AbortSignal.timeout(15_000),
          headers: { Authorization: `Bearer ${this.token}` },
        });
      }
      if (!res.ok) throw new Error(`TVDB HTTP ${res.status} for ${path}`);
      return (await res.json()) as T;
    }

    // shared-proxy mode: no client-side auth — the Worker injects the bearer token.
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`TVDB HTTP ${res.status} for ${path}`);
    return (await res.json()) as T;
  }

  private async login(): Promise<void> {
    if (!this.apiKey) throw new Error("TVDB login requires an apiKey (shared-proxy mode needs none)");
    const res = await this.fetchImpl(`${this.baseUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apikey: this.apiKey }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`TVDB login failed: HTTP ${res.status}`);
    const j = (await res.json()) as { data?: { token?: string } };
    const token = j?.data?.token;
    if (!token) throw new Error("TVDB login returned no token");
    this.token = token;
    this.tokenValidUntil = Date.now() + TOKEN_TTL_MS;
  }
}
