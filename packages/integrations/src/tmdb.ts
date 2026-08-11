// SPDX-License-Identifier: MIT
/**
 * TMDB metadata provider (HTTP, public v3 API) — movies + series + seasons/episodes.
 * Reimplemented against TMDB's documented API; base URL overridable for tests.
 * TMDB is the primary metadata source for movies and series (Seerr's model); TVDB ids
 * come back via /find?external_source=tvdb_id /external_ids for TV identity.
 */
import type { MetadataProviderContract, MediaSummary } from "./contracts";

export interface TmdbSettings {
  apiKey: string;
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

export class TmdbProvider implements MetadataProviderContract {
  readonly key = "tmdb";
  private readonly settings: TmdbSettings;
  constructor(settings: TmdbSettings, private readonly fetchImpl = fetch) {
    this.settings = { language: "en-US", ...settings, baseUrl: settings.baseUrl ?? "https://api.themoviedb.org/3" };
  }
  private base() { return this.settings.baseUrl!.replace(/\/$/, ""); }
  private q(params: Record<string, string>): string {
    const u = new URLSearchParams({ api_key: this.settings.apiKey, language: this.settings.language ?? "en-US", ...params });
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
    const d = await this.get<TmdbSeriesDetail>(`/tv/${tmdbId}`);
    return d.external_ids?.tvdb_id ?? null;
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

/** Deterministic in-memory provider for tests/demo. */
export class MemoryMetadataProvider implements MetadataProviderContract {
  readonly key = "memory";
  constructor(private readonly preset: Record<string, { mediaType: "movie" | "series"; title: string }> = {}) {}
  async search(query: string, mediaType: "movie" | "series") {
    return Object.values(this.preset)
      .filter((p) => p.mediaType === mediaType && p.title.toLowerCase().includes(query.toLowerCase()))
      .map((p, i) => ({ externalId: String(i + 1), title: p.title }));
  }
  async getDetails(mediaType: "movie" | "series", externalId: string): Promise<MediaSummary> {
    return { externalId, title: this.preset[externalId]?.title ?? "Unknown", overview: "memory metadata" };
  }
}
