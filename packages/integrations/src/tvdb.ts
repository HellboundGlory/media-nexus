// SPDX-License-Identifier: MIT
/**
 * TheTVDB v4 metadata provider — the primary series metadata source (search/add/refresh, real
 * Sonarr parity) plus the additive numbering backfill it started as (roadmap P2, gap D8).
 *
 * TheTVDB keeps one canonical record per show where TMDB often splits a continuation into a
 * second id (Top Boy 2011/2019 is the canonical case), which is why series search/add/metadata
 * is TVDB-driven while movies stay TMDB. It also carries the fields TMDB does not expose for
 * TV series: `absoluteNumber`, and the DVD/scene ordering that maps onto our
 * `episode.absoluteNumber` / `episode.sceneSeasonNumber` / `episode.sceneEpisodeNumber`.
 *
 * Note: deliberately does NOT implement `MetadataProviderContract` — that contract is for
 * two-mediaType discovery providers. TvdbProvider is series-only with plain dedicated methods,
 * named like TmdbProvider's (search/getDetails/seriesSeasons) for consistency.
 *
 * Two modes, mirroring the TmdbProvider shape:
 *  - shared-proxy (default): no `apiKey` → calls go to the MediaNexus Cloudflare proxy URL
 *    (which holds the key, exactly like Sonarr's `skyhook.sonarr.tv`). The proxy authenticates
 *    transparently, so the client performs no login.
 *  - BYO-key: an `apiKey` is supplied → base URL defaults to the real TVDB API and the client
 *    does its own login / bearer-token cache / 401 re-login retry.
 */
import type { MediaSummary } from "./contracts";

export const DEFAULT_TVDB_WORKER_URL = "https://medianexus-proxy.hellboundg-e09.workers.dev/tvdb";
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
  /** Content fields used by the season/episode assembly (`seriesSeasons`); absent on raw
   *  numbering-only fetches only because TVDB omitted them. Optional so the numbering-backfill
   *  consumers are unaffected by their presence. */
  name?: string;
  overview?: string;
  /** TVDB's own finale marker ("season" | "midseason" | "series"); undefined on regular episodes. */
  finaleType?: string;
}

/** One episode in the assembled `seriesSeasons()` output — the fields the refresh upsert loop
 *  needs, already normalized (no vendor shapes). */
export interface TvdbSeasonEpisode {
  episodeNumber: number;
  name?: string;
  overview?: string;
  /** ISO date (YYYY-MM-DD). */
  airDate: string | null;
  /** Normalized finale marker driving EPISODEDETAIL-1's badges: "finale" (series finale) or
   *  "mid_season"; anything else stays undefined — no invented badge values. */
  episodeType?: string;
}

/** A season with its episodes under the official (Aired Order) ordering — the
 *  `TmdbProvider.seriesSeasons()` equivalent for series. */
export interface TvdbSeasonWithEpisodes {
  seasonNumber: number;
  episodes: TvdbSeasonEpisode[];
}

/** A cross-source id on a TVDB record (search `remote_ids` / extended `remoteIds`). */
export interface TvdbRemoteId {
  id?: string;
  type?: number;
  sourceName?: string;
}

interface RawSearchResult {
  tvdb_id?: string | number;
  name?: string;
  overview?: string;
  first_air_time?: string | null;
  year?: string | number;
  image_url?: string | null;
  status?: string;
  aliases?: unknown;
  remote_ids?: TvdbRemoteId[] | null;
}

interface RawSeriesExtended {
  id?: number;
  name?: string;
  overview?: string | null;
  image?: string | null;
  firstAired?: string | null;
  year?: string | number;
  status?: { name?: string } | null;
  genres?: Array<{ name?: string }> | null;
  contentRatings?: Array<{ name?: string; country?: string }> | null;
  averageRuntime?: number | null;
  score?: number | null;
  remoteIds?: TvdbRemoteId[] | null;
  seasons?: Array<{ number?: number | null; type?: { type?: string | null } | null }> | null;
}

interface RawEpisode {
  id?: number; seasonNumber?: number | null; number?: number | null;
  absoluteNumber?: number | null; aired?: string | null;
  name?: string | null; overview?: string | null; finaleType?: string | null;
}
interface RawEpisodesPage {
  data?: { episodes?: RawEpisode[] };
  links?: { next?: string | null };
}

/**
 * TMDB id from a TVDB record's remote ids, best-effort. The sourceName string for TMDB was
 * verified live ("TheMovieDB.com", numeric-string id); anything else — missing list, other
 * sources, non-numeric id — yields undefined rather than a guess.
 */
export function tmdbIdFromRemoteIds(remoteIds?: TvdbRemoteId[] | null): number | undefined {
  const hit = (remoteIds ?? []).find((r) => r?.sourceName === "TheMovieDB.com");
  const n = typeof hit?.id === "string" ? Number(hit.id) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** TVDB finaleType -> our episode_type vocabulary (EPISODEDETAIL-1). TVDB has no explicit
 *  premiere marker and its plain "season" finales have no TMDB counterpart we ever stored,
 *  so both map to undefined rather than an invented value. Verified live 2026-08-22 against
 *  Top Boy (S05E06 "series") and House (S08E22 "series"). */
function finaleTypeToEpisodeType(finaleType?: string | null): string | undefined {
  if (finaleType === "series") return "finale";
  if (finaleType === "midseason") return "mid_season";
  return undefined;
}

function yearOf(value: string | number | null | undefined): number | undefined {
  if (value == null || `${value}` === "") return undefined;
  const y = Number(String(value).slice(0, 4));
  return Number.isInteger(y) && y > 0 ? y : undefined;
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

  /**
   * Series search against GET /search?query=X&type=series.
   *
   * TVDB v4 search is an Elasticsearch fuzzy index — a "Top Boy" query also surfaces "Toy Boy",
   * "Bop Box", etc. Real Sonarr's skyhook layer sits in front of the same data and returns strict
   * title matches, which is why Add Series there shows one clean result. Post-filtering on
   * case-insensitive containment across name + aliases reproduces that behaviour without a second
   * endpoint; without it the actual hit drowns in fuzz matches.
   */
  async search(query: string): Promise<MediaSummary[]> {
    const j = await this.get<{ data?: RawSearchResult[] }>(`/search?query=${encodeURIComponent(query)}&type=series`);
    const q = query.trim().toLowerCase();
    const hits = (j?.data ?? []).filter((r) => {
      if (!q) return true;
      const haystack = [r.name, ...(Array.isArray(r.aliases) ? r.aliases : [])]
        .filter((s): s is string => typeof s === "string")
        .join("\n")
        .toLowerCase();
      return haystack.includes(q);
    });
    return hits.map((r) => ({
      externalId: String(r.tvdb_id ?? ""),
      title: r.name ?? "",
      releaseDate: r.first_air_time ?? undefined,
      year: yearOf(r.year ?? r.first_air_time),
      overview: r.overview ?? undefined,
      status: r.status ?? undefined,
      images: r.image_url ? [{ coverType: "poster", url: r.image_url }] : [],
      // No rating field exists on search results, and the extended record's `score` is a large
      // popularity count (see getDetails), not a comparable 0-10 rating — leave rating unset.
    }));
  }

  /**
   * Series details from GET /series/{id}/extended. Returns MediaSummary, plus a `tmdbId`
   * extension read off remoteIds when present (best-effort backfill input for series.tmdbId).
   */
  async getDetails(externalId: string): Promise<MediaSummary & { tmdbId?: number }> {
    const j = await this.get<{ data?: RawSeriesExtended }>(`/series/${externalId}/extended`);
    const d = j?.data ?? {};
    // Certification: prefer the US entry (country strings verified live as lowercase ISO-3166-1
    // alpha-3, e.g. "usa"), falling back to the first rating listed.
    const ratings = d.contentRatings ?? [];
    const cr = ratings.find((r) => r?.country === "usa") ?? ratings[0];
    return {
      externalId: String(d.id ?? externalId),
      title: d.name ?? "",
      releaseDate: d.firstAired ?? undefined,
      year: yearOf(d.firstAired ?? d.year),
      overview: d.overview ?? undefined,
      status: d.status?.name ?? undefined,
      genres: (d.genres ?? []).map((g) => g?.name ?? "").filter(Boolean),
      images: d.image ? [{ coverType: "poster", url: d.image }] : [],
      certification: cr?.name || undefined,
      runtime: typeof d.averageRuntime === "number" && d.averageRuntime > 0 ? d.averageRuntime : undefined,
      // `score` is deliberately NOT mapped into rating: it is a popularity/vote count on a huge
      // scale (Top Boy: 157013), not a 0-10 vote_average — displaying it would mislead.
      tmdbId: tmdbIdFromRemoteIds(d.remoteIds),
    };
  }

  /**
   * All seasons + episodes for a series under TVDB's official (Aired Order) ordering. Seasons
   * come from the extended record's seasons list filtered to `type.type === "official"` (the
   * same list also carries dvd/absolute/alternate orderings, which would double-count);
   * episodes from `episodes("official")`, grouped and ordered per season.
   */
  async seriesSeasons(externalId: string): Promise<TvdbSeasonWithEpisodes[]> {
    const [ext, eps] = await Promise.all([
      this.get<{ data?: Pick<RawSeriesExtended, "seasons"> }>(`/series/${externalId}/extended`),
      this.episodes(Number(externalId), "official"),
    ]);
    const officialNumbers = [...new Set(
      (ext?.data?.seasons ?? [])
        .map((s) => (s?.type?.type === "official" && typeof s.number === "number" ? s.number : null))
        .filter((n): n is number => n != null),
    )].sort((a, b) => a - b);

    const bySeason = new Map<number, TvdbSeasonEpisode[]>();
    for (const e of eps) {
      if (e.seasonNumber == null || e.number == null) continue;
      const list = bySeason.get(e.seasonNumber) ?? [];
      list.push({
        episodeNumber: e.number,
        name: e.name,
        overview: e.overview,
        airDate: e.aired,
        episodeType: finaleTypeToEpisodeType(e.finaleType),
      });
      bySeason.set(e.seasonNumber, list);
    }
    return officialNumbers.map((seasonNumber) => ({
      seasonNumber,
      episodes: (bySeason.get(seasonNumber) ?? []).sort((a, b) => a.episodeNumber - b.episodeNumber),
    }));
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
          name: e.name ?? undefined,
          overview: e.overview ?? undefined,
          finaleType: e.finaleType ?? undefined,
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
