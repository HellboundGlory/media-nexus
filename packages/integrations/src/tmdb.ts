// SPDX-License-Identifier: MIT
/**
 * TMDB metadata provider (HTTP, public v3 API) — movies + series + seasons/episodes.
 * Reimplemented against TMDB's documented API; base URL overridable for tests.
 * TMDB is the primary metadata source for movies and series (Seerr's model); TVDB ids
 * come back via /find?external_source=tvdb_id /external_ids for TV identity.
 */
import type { MetadataProviderContract, MediaSummary } from "./contracts";

/** Default shared TMDB proxy (see infra/cloudflare). Public by design — the Worker injects the
 *  real key. Used as `metadata.tmdbBaseUrl` when the user hasn't set their own key OR base URL;
 *  use via TmdbProvider with apiKey unset (proxy mode). */
export const DEFAULT_TMDB_WORKER_URL = "https://medianexus-proxy.hellboundg-e09.workers.dev/tmdb";

export interface TmdbSettings {
  /** Leave unset to use the shared proxy (baseUrl must then be the proxy's /tmdb URL, which is the
   *  default) — the Worker injects the real key. Set to use your own TMDB key directly. */
  apiKey?: string;
  baseUrl?: string; // default https://api.themoviedb.org/3
  language?: string;
}

export interface TmdbEpisode { episode_number: number; name: string; air_date: string | null; overview: string }
export interface TmdbSeason { season_number: number; episodes?: TmdbEpisode[] }
export interface TmdbSeriesDetail {
  id: number; name?: string; overview?: string; first_air_date?: string | null;
  genres?: { name: string }[]; networks?: { name: string }[]; number_of_seasons?: number;
  poster_path?: string | null;
  external_ids?: { tvdb_id?: number | null };
}
export interface TmdbMovieDetail {
  id: number; title?: string; overview?: string; release_date?: string | null;
  genres?: { name: string }[]; poster_path?: string | null;
}

export type DiscoverCategory = "trending" | "popular" | "upcoming" | "top_rated";

export interface DiscoverItem {
  tmdbId: number;
  mediaType: "movie" | "series";
  title: string;
  overview: string;
  releaseDate: string | null;
  year: number | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  rating: number | null;
}
export interface DiscoverPage {
  page: number;
  totalPages: number;
  totalResults: number;
  results: DiscoverItem[];
}
interface TmdbDiscoverRawItem {
  id: number; title?: string; name?: string; overview?: string;
  release_date?: string | null; first_air_date?: string | null;
  poster_path?: string | null; backdrop_path?: string | null; vote_average?: number;
}

export class TmdbProvider implements MetadataProviderContract {
  readonly key = "tmdb";
  private readonly settings: TmdbSettings;
  constructor(settings: TmdbSettings, private readonly fetchImpl = fetch) {
    this.settings = { language: "en-US", ...settings, baseUrl: settings.baseUrl ?? "https://api.themoviedb.org/3" };
  }
  private base() { return this.settings.baseUrl!.replace(/\/$/, ""); }
  private q(params: Record<string, string>): string {
    const u = new URLSearchParams({ language: this.settings.language ?? "en-US", ...params });
    // Own-key mode sends the key; proxy mode (apiKey unset) omits it so the Worker can inject it.
    if (this.settings.apiKey) u.set("api_key", this.settings.apiKey);
    return `?${u.toString()}`;
  }
  private async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const res = await this.fetchImpl(`${this.base()}${path}${this.q(params)}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`TMDB HTTP ${res.status} for ${path}`);
    return res.json() as Promise<T>;
  }

  async search(query: string, mediaType: "movie" | "series"): Promise<MediaSummary[]> {
    const data = mediaType === "movie"
      ? await this.get<{ results?: TmdbMovieDetail[] }>("/search/movie", { query })
      : await this.get<{ results?: TmdbSeriesDetail[] }>("/search/tv", { query });
    return (data.results ?? []).map((r: any) => ({
      externalId: String(r.id),
      title: r.title ?? r.name ?? "",
      releaseDate: r.release_date ?? r.first_air_date ?? undefined,
      year: r.release_date ? Number(String(r.release_date).slice(0, 4)) : r.first_air_date ? Number(String(r.first_air_date).slice(0, 4)) : undefined,
      overview: r.overview,
      genres: (r.genre_ids ?? r.genres ?? []).map((g: any) => (typeof g === "string" ? g : g.name ?? "")).filter(Boolean),
      images: r.poster_path ? [{ coverType: "poster", url: `https://image.tmdb.org/t/p/w500${r.poster_path}` }] : [],
    }));
  }

  async getDetails(mediaType: "movie" | "series", externalId: string): Promise<MediaSummary> {
    const d = mediaType === "movie"
      ? await this.get<TmdbMovieDetail>(`/movie/${externalId}`)
      : await this.get<TmdbSeriesDetail>(`/tv/${externalId}`, {});
    return {
      externalId: String(d.id),
      title: (d as any).title ?? (d as any).name ?? "",
      releaseDate: (d as any).release_date ?? (d as any).first_air_date ?? undefined,
      year: (d as any).release_date ? Number(String((d as any).release_date).slice(0, 4)) : (d as any).first_air_date ? Number(String((d as any).first_air_date).slice(0, 4)) : undefined,
      overview: d.overview,
      genres: ((d as any).genres ?? []).map((g: any) => g.name ?? "").filter(Boolean),
      images: d.poster_path ? [{ coverType: "poster", url: `https://image.tmdb.org/t/p/w500${d.poster_path}` }] : [],
    };
  }

  /** TMDB -> TVDB mapping via /find/{tvdbId}?external_source=tvdb_id */
  async tmdbIdForTvdb(tvdbId: number): Promise<string | null> {
    const data = await this.get<{ tv_results?: { id: number }[] }>(`/find/${tvdbId}`, { external_source: "tvdb_id" });
    return data.tv_results?.[0] ? String(data.tv_results[0].id) : null;
  }

  async tvdbIdForTmdb(tmdbId: number): Promise<number | null> {
    // external_ids is only present on /tv/{id} when explicitly appended
    const d = await this.get<TmdbSeriesDetail>(`/tv/${tmdbId}`, { append_to_response: "external_ids" });
    return d.external_ids?.tvdb_id ?? null;
  }

  /** Trending/popular/upcoming/top-rated browse lists (TMDB list endpoints, paginated). */
  async discover(mediaType: "movie" | "series", category: DiscoverCategory, page = 1): Promise<DiscoverPage> {
    const data = await this.get<{ page: number; total_pages: number; total_results: number; results?: TmdbDiscoverRawItem[] }>(
      this.discoverPath(mediaType, category), { page: String(page) },
    );
    const results = (data.results ?? []).map((r): DiscoverItem => ({
      tmdbId: r.id,
      mediaType,
      title: r.title ?? r.name ?? "",
      overview: r.overview ?? "",
      releaseDate: r.release_date ?? r.first_air_date ?? null,
      year: (r.release_date ?? r.first_air_date) ? Number(String(r.release_date ?? r.first_air_date).slice(0, 4)) : null,
      posterUrl: r.poster_path ? `https://image.tmdb.org/t/p/w342${r.poster_path}` : null,
      backdropUrl: r.backdrop_path ? `https://image.tmdb.org/t/p/w780${r.backdrop_path}` : null,
      rating: r.vote_average ?? null,
    }));
    return { page: data.page, totalPages: data.total_pages, totalResults: data.total_results, results };
  }

  private discoverPath(mediaType: "movie" | "series", category: DiscoverCategory): string {
    if (category === "trending") return `/trending/${mediaType === "movie" ? "movie" : "tv"}/week`;
    const kind = mediaType === "movie" ? "movie" : "tv";
    const suffix = category === "popular" ? "popular"
      : category === "upcoming" ? (mediaType === "movie" ? "upcoming" : "on_the_air")
      : "top_rated";
    return `/${kind}/${suffix}`;
  }

  /** Items in a user-created TMDB list (`/list/{listId}`, paginated via `page`), for
   *  import lists (roadmap P2, gap C2). */
  async listItems(listId: string, maxPages = 5): Promise<Array<{ mediaType: "movie" | "series"; tmdbId: number }>> {
    const out: Array<{ mediaType: "movie" | "series"; tmdbId: number }> = [];
    for (let page = 1; page <= maxPages; page++) {
      const data = await this.get<{ items?: Array<{ id: number; media_type?: string }> }>(`/list/${listId}`, { page: String(page) });
      const items = data.items ?? [];
      for (const it of items) {
        if (it && typeof it.id === "number") out.push({ mediaType: it.media_type === "tv" ? ("series" as const) : ("movie" as const), tmdbId: it.id });
      }
      if (items.length === 0) break;
    }
    return out;
  }

  /** All seasons + episodes for a series. */
  async seriesSeasons(tmdbId: number): Promise<TmdbSeason[]> {
    const detail = await this.get<TmdbSeriesDetail>(`/tv/${tmdbId}`);
    const count = detail.number_of_seasons ?? 0;
    const out: TmdbSeason[] = [];
    for (let n = 0; n <= count; n++) {
      try {
        const s = await this.get<{ season_number: number; episodes?: TmdbEpisode[] }>(`/tv/${tmdbId}/season/${n}`);
        out.push({ season_number: s.season_number, episodes: s.episodes ?? [] });
      } catch { /* skip missing season */ }
    }
    return out;
  }
}
