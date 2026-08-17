// SPDX-License-Identifier: MIT
/**
 * TMDB metadata provider (HTTP, public v3 API) — movies + series + seasons/episodes.
 * Reimplemented against TMDB's documented API; base URL overridable for tests.
 * TMDB is the primary metadata source for movies and series (Seerr's model); TVDB ids
 * come back via /find?external_source=tvdb_id /external_ids for TV identity.
 */
import type { MetadataProviderContract, MediaSummary, CreditPerson } from "./contracts";

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
  poster_path?: string | null; vote_average?: number;
  episode_run_time?: number[];
  last_episode_to_air?: { runtime?: number };
  content_ratings?: { results: { iso_3166_1?: string; rating?: string }[] };
  videos?: { results: TmdbVideo[] };
  external_ids?: { tvdb_id?: number | null };
}
export interface TmdbMovieDetail {
  id: number; title?: string; overview?: string; release_date?: string | null;
  genres?: { name: string }[]; poster_path?: string | null; runtime?: number;
  vote_average?: number; production_companies?: { name?: string }[];
  release_dates?: { results: TmdbReleaseDateRegion[] };
  videos?: { results: TmdbVideo[] };
  belongs_to_collection?: { id: number; name: string } | null;
}
export interface TmdbVideo { site?: string; type?: string; key?: string }
export interface TmdbReleaseDateEntry {
  type?: number; release_date?: string | null; certification?: string;
}
export interface TmdbReleaseDateRegion {
  iso_3166_1?: string; release_dates?: TmdbReleaseDateEntry[];
}

// Credits response (DETAILPAGE-BE2) — verified against the live API: GET /movie|tv/{id}/credits.
export interface TmdbCreditEntry {
  id: number; name?: string; character?: string; job?: string; department?: string;
  order?: number; profile_path?: string | null;
}
export interface TmdbCreditsResponse {
  cast?: TmdbCreditEntry[];
  crew?: TmdbCreditEntry[];
}

// Release-dates certification/type filter region. No per-user region setting exists anywhere
// in the app (single admin, LAN-only); US is the stable default the rest of the pipeline
// assumes, matching the app language default's territory. Region here is ISO-3166-1 (country),
// distinct from the `language` (ISO-639-1) the provider is already configured with.
const DETAILS_REGION = "US";

// TMDB release-date `type` codes (their documented enum): 3=Theatrical, 4=Digital, 5=Physical.
const RELEASE_TYPE = { inCinemas: 3, digital: 4, physical: 5 } as const;

// Curated set of key crew jobs to keep when fetching credits (DETAILPAGE-BE2). Full TMDB crew
// lists are enormous (Fight Club: 188 entries) and mostly noise (grips, editors, sound, ...
// are real data but not what a user browsing a movie card wants). Job strings are TMDB's
// case-sensitive `job` values, verified against the live API. Scope decision per task — adjust
// here if real data reveals something obviously missing.
const KEY_CREW_JOBS = new Set([
  "Director",
  "Writer",
  "Screenplay",
  "Story",
  "Creator",
  "Executive Producer",
]);

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
      // TMDB's /search/movie and /search/tv both carry vote_average per result (same field
      // getDetails reads for tmdbRating); MediaSummary.rating already exists — this populates it.
      rating: r.vote_average ?? undefined,
      genres: (r.genre_ids ?? r.genres ?? []).map((g: any) => (typeof g === "string" ? g : g.name ?? "")).filter(Boolean),
      images: r.poster_path ? [{ coverType: "poster", url: `https://image.tmdb.org/t/p/w500${r.poster_path}` }] : [],
    }));
  }

  async getDetails(mediaType: "movie" | "series", externalId: string): Promise<MediaSummary> {
    if (mediaType === "movie") return this.getMovieDetails(externalId);
    return this.getSeriesDetails(externalId);
  }

  private async getMovieDetails(externalId: string): Promise<MediaSummary> {
    const d = await this.get<TmdbMovieDetail>(`/movie/${externalId}`, { append_to_response: "release_dates,videos" });
    // Certification + three-way release dates come from the region-scoped release_dates block:
    // pick the US entry (fallback: first region that has one) and read `type` 3/4/5 for
    // in-cinemas / digital / physical, with certification read off the theatrical (type 3)
    // entry — that's the classification that governs a cinema release.
    let certification: string | undefined;
    let inCinemas: string | undefined;
    let digitalRelease: string | undefined;
    let physicalRelease: string | undefined;
    const region = (d.release_dates?.results ?? []).find((r) => r.iso_3166_1 === DETAILS_REGION)
      ?? (d.release_dates?.results ?? [])[0];
    for (const e of region?.release_dates ?? []) {
      if (e.type === RELEASE_TYPE.inCinemas) {
        if (e.certification) certification = e.certification;
        inCinemas = e.release_date ?? undefined;
      } else if (e.type === RELEASE_TYPE.digital && !digitalRelease) {
        digitalRelease = e.release_date ?? undefined;
      } else if (e.type === RELEASE_TYPE.physical && !physicalRelease) {
        physicalRelease = e.release_date ?? undefined;
      }
    }
    // Prefer certification from the theatrical release; fall back to the first region entry.
    if (!certification) certification = region?.release_dates?.find((e) => e.certification)?.certification;
    const trailer = (d.videos?.results ?? []).find((v) => v.site === "YouTube" && v.type === "Trailer");
    return {
      externalId: String(d.id),
      title: d.title ?? "",
      releaseDate: d.release_date ?? undefined,
      year: d.release_date ? Number(String(d.release_date).slice(0, 4)) : undefined,
      overview: d.overview,
      genres: (d.genres ?? []).map((g) => g.name ?? "").filter(Boolean),
      images: d.poster_path ? [{ coverType: "poster", url: `https://image.tmdb.org/t/p/w500${d.poster_path}` }] : [],
      rating: d.vote_average ?? undefined,
      certification,
      runtime: d.runtime ?? undefined,
      studio: d.production_companies?.[0]?.name ?? undefined,
      inCinemas,
      digitalRelease,
      physicalRelease,
      trailerId: trailer?.key,
      // Collection (DETAILPAGE-BE3): belongs_to_collection is null-or-present on the base movie
      // response. Map absence to undefined (consistent with the rest of MediaSummary's optional
      // fields) so a movie with no collection reads the same as can-be-undefined anywhere else.
      collectionTmdbId: d.belongs_to_collection?.id ?? undefined,
      collectionName: d.belongs_to_collection?.name ?? undefined,
    };
  }

  private async getSeriesDetails(externalId: string): Promise<MediaSummary> {
    const d = await this.get<TmdbSeriesDetail>(`/tv/${externalId}`, { append_to_response: "content_ratings,videos" });
    // Certification from the region-scoped content_ratings block (US first, else first entry).
    const crRegion = d.content_ratings?.results ?? [];
    const cr = crRegion.find((r) => r.iso_3166_1 === DETAILS_REGION) ?? crRegion[0];
    const trailer = (d.videos?.results ?? []).find((v) => v.site === "YouTube" && v.type === "Trailer");
    // Runtime: prefer `episode_run_time[0]`, but that list is empty on many current TMDB series
    // (it has drifted), so fall back to the last aired episode's runtime when present.
    const runtime = Number(d.episode_run_time?.[0]) || d.last_episode_to_air?.runtime || undefined;
    return {
      externalId: String(d.id),
      title: d.name ?? "",
      releaseDate: d.first_air_date ?? undefined,
      year: d.first_air_date ? Number(String(d.first_air_date).slice(0, 4)) : undefined,
      overview: d.overview,
      genres: (d.genres ?? []).map((g) => g.name ?? "").filter(Boolean),
      images: d.poster_path ? [{ coverType: "poster", url: `https://image.tmdb.org/t/p/w500${d.poster_path}` }] : [],
      rating: d.vote_average ?? undefined,
      certification: cr?.rating || undefined,
      runtime,
      trailerId: trailer?.key,
    };
  }

  /**
   * Cast & crew for a movie/series (roadmap P3 / DETAILPAGE-BE2). One call to the credits
   * endpoint. Cast: ALL entries kept (TMDB `order` is the billing order the frontend sorts by).
   * Crew: filtered at fetch time to a curated set of key jobs — full crew lists are huge
   * (Fight Club has 188) and mostly noise for a user browsing a movie card. Keep the creative
   * principals; drop grips/editors/sound/etc. Job strings are case-sensitive TMDB `job` values
   * (verified live). \`Creator\` is included for series but note it rarely appears in the
   * series *credits* payload (creators live in the series \`created_by\` field instead), so a
   * series crew will typically yield Executive Producer / Director / Writer when present.
   */
  async getCredits(mediaType: "movie" | "series", externalId: string): Promise<{ cast: CreditPerson[]; crew: CreditPerson[] }> {
    const d = await this.get<TmdbCreditsResponse>(`/${mediaType === "movie" ? "movie" : "tv"}/${externalId}/credits`);
    const toPerson = (c: TmdbCreditEntry): CreditPerson => ({
      id: c.id,
      name: c.name ?? "",
      character: c.character,
      job: c.job,
      department: c.department,
      order: c.order,
      profileUrl: c.profile_path ? `https://image.tmdb.org/t/p/w185${c.profile_path}` : undefined,
    });
    const cast = (d.cast ?? []).map(toPerson);
    const crew = (d.crew ?? []).filter((c) => KEY_CREW_JOBS.has(c.job ?? "")).map(toPerson);
    return { cast, crew };
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
