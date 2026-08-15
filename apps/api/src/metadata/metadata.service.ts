// SPDX-License-Identifier: MIT
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { ApiError } from "@medianexus/shared";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import { ConfigService } from "../system/config.service";
import { TmdbProvider, TvdbProvider, type TvdbEpisodeRecord } from "@medianexus/integrations";
import type { MediaSummary, DiscoverCategory } from "@medianexus/integrations";
import { MoviesService } from "../movies/movies.service";
import { SeriesService } from "../series/series.service";

/**
 * Metadata import (metadata): TMDB provides movie/series enrichment and — critically —
 * auto-populates seasons + episodes (M2 previously needed manual episode seeding).
 */
@Injectable()
export class MetadataService {
  private readonly logger = new Logger(MetadataService.name);
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly config: ConfigService,
    private readonly movies: MoviesService,
    private readonly series: SeriesService,
  ) {}

  async provider(): Promise<TmdbProvider | null> {
    const c = await this.config.get();
    const apiKey = c["metadata.tmdbApiKey"];
    if (!apiKey) return null;
    const baseUrl = c["metadata.tmdbBaseUrl"] || undefined;
    return new TmdbProvider({ apiKey, baseUrl });
  }

  /**
   * TheTVDB numbering backfill client. Always constructable (no key required): empty
   * `metadata.tvdbBaseUrl` falls back to the shared Cloudflare proxy (which authenticates),
   * and a non-empty `metadata.tvdbApiKey` switches to BYO-key mode against the real API.
   */
  async tvdbProvider(): Promise<TvdbProvider> {
    const c = await this.config.get();
    return new TvdbProvider({
      baseUrl: c["metadata.tvdbBaseUrl"] || undefined,
      apiKey: c["metadata.tvdbApiKey"] || undefined,
    });
  }

  async lookup(query: string, mediaType: "movie" | "series"): Promise<MediaSummary[]> {
    const p = await this.provider();
    if (!p) throw new ApiError({ code: "UNPROCESSABLE", message: "metadata.tmdbApiKey is not configured" });
    return p.search(query, mediaType);
  }

  async refreshMovie(movieId: string): Promise<{ updated: boolean; title?: string }> {
    const p = await this.provider();
    if (!p) throw new ApiError({ code: "UNPROCESSABLE", message: "metadata.tmdbApiKey is not configured" });
    const movie = await this.db.select().from(schema.movie).where(eq(schema.movie.id, movieId)).limit(1);
    if (!movie[0]) throw ApiError.notFound("movie", movieId);
    if (!movie[0].tmdbId) throw new ApiError({ code: "UNPROCESSABLE", message: "movie has no tmdbId" });
    const d = await p.getDetails("movie", String(movie[0].tmdbId));
    await this.db.update(schema.movie).set({
      overview: d.overview ?? movie[0].overview ?? "",
      genres: d.genres ?? [],
      images: d.images ?? [],
      releaseDate: d.releaseDate ?? movie[0].releaseDate,
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.movie.id, movieId));
    return { updated: true, title: d.title };
  }

  async refreshSeries(seriesId: string): Promise<{ updated: boolean; title?: string; seasons: number; episodes: number }> {
    const p = await this.provider();
    if (!p) throw new ApiError({ code: "UNPROCESSABLE", message: "metadata.tmdbApiKey is not configured" });
    const series = await this.db.select().from(schema.series).where(eq(schema.series.id, seriesId)).limit(1);
    if (!series[0]) throw ApiError.notFound("series", seriesId);

    const tmdbId = series[0].tvdbId ? await p.tmdbIdForTvdb(series[0].tvdbId) : null;
    if (!tmdbId) throw new ApiError({ code: "UNPROCESSABLE", message: "could not resolve a TMDB id for this series (needs tvdbId)" });

    const d = await p.getDetails("series", tmdbId);
    const seasons = await p.seriesSeasons(Number(tmdbId));
    await this.db.update(schema.series).set({
      overview: d.overview ?? series[0].overview ?? "",
      genres: d.genres ?? [],
      images: d.images ?? [],
      firstAirYear: d.year ?? series[0].firstAirYear,
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.series.id, seriesId));

    // upsert seasons + episodes idempotently
    let seasonCount = 0;
    let episodeCount = 0;
    for (const season of seasons) {
      const existing = await this.db.select({ id: schema.season.id }).from(schema.season)
        .where(and(eq(schema.season.seriesId, seriesId), eq(schema.season.seasonNumber, season.season_number))).limit(1);
      let seasonId = existing[0]?.id ?? null;
      if (!seasonId) {
        seasonId = `sea_${seriesId}_${season.season_number}`;
        await this.db.insert(schema.season).values({ id: seasonId, seriesId, seasonNumber: season.season_number, monitored: true });
        seasonCount++;
      }
      for (const ep of season.episodes ?? []) {
        const epId = `ep_${seriesId}_${season.season_number}_${ep.episode_number}`;
        const exists = await this.db.select({ id: schema.episode.id }).from(schema.episode).where(eq(schema.episode.id, epId)).limit(1);
        if (exists[0]) continue;
        await this.db.insert(schema.episode).values({
          id: epId, seriesId, seasonId, episodeNumber: ep.episode_number, title: ep.name ?? "",
          overview: ep.overview ?? "", airDateUtc: ep.air_date ?? null, monitored: true, hasFile: false,
        });
        episodeCount++;
      }
    }
    this.logger.log(`metadata refresh "${series[0].title}": +${seasonCount} seasons +${episodeCount} episodes`);

    // Best-effort TheTVDB numbering backfill (roadmap P2, gap D8): TMDB does not expose
    // absolute/scene numbers, so fill `absoluteNumber` / `sceneSeasonNumber` /
    // `sceneEpisodeNumber` from TVDB. Strictly additive and non-fatal — a TVDB failure must
    // never fail the TMDB portion of the refresh (which already succeeded above).
    await this.backfillTvdbNumbering(series[0]);
    await this.backfillTvdbAliases(series[0]);

    return { updated: true, title: d.title, seasons: seasonCount, episodes: episodeCount };
  }

  /**
   * Backfill the TVDB-only numbering fields on a series' episode rows.
   *
   * Fetch the `official` ordering (matches the TMDB season/episode numbers local rows already
   * use, and carries each episode's `absoluteNumber`) and the `dvd` ordering (the closest
   * analog to scene numbering -> `sceneSeasonNumber`/`sceneEpisodeNumber`). Join by TVDB
   * episode id, then to local rows by (seasonNumber, episodeNumber). Graceful on every failure
   * edge: an unreachable worker, a series TVDB has no numbering for, or missing DVD ordering
   * just leaves the fields null and logs a warning — never throws out of refreshSeries.
   */
  private async backfillTvdbNumbering(series: typeof schema.series.$inferSelect): Promise<void> {
    if (!series.tvdbId) return;
    const tvdb = await this.tvdbProvider();
    try {
      const official = await tvdb.episodes(series.tvdbId, "official");
      // DVD ordering is optional per series — treat its absence as "no scene numbering".
      let dvd: TvdbEpisodeRecord[] = [];
      try { dvd = await tvdb.episodes(series.tvdbId, "dvd"); } catch { /* no DVD ordering */ }

      const officialById = new Map<number, TvdbEpisodeRecord>();
      const idByOfficialKey = new Map<string, number>(); // "season:number" -> tvdb episode id
      for (const e of official) {
        if (!e.id) continue;
        officialById.set(e.id, e);
        if (e.seasonNumber != null && e.number != null) idByOfficialKey.set(`${e.seasonNumber}:${e.number}`, e.id);
      }
      const dvdById = new Map<number, TvdbEpisodeRecord>();
      for (const e of dvd) if (e.id) dvdById.set(e.id, e);

      const rows = await this.db
        .select({
          id: schema.episode.id,
          seasonNumber: schema.season.seasonNumber,
          episodeNumber: schema.episode.episodeNumber,
          absoluteNumber: schema.episode.absoluteNumber,
          sceneSeasonNumber: schema.episode.sceneSeasonNumber,
          sceneEpisodeNumber: schema.episode.sceneEpisodeNumber,
        })
        .from(schema.episode)
        .innerJoin(schema.season, eq(schema.episode.seasonId, schema.season.id))
        .where(eq(schema.episode.seriesId, series.id));

      let updated = 0;
      for (const ep of rows) {
        const tvdbId = idByOfficialKey.get(`${ep.seasonNumber}:${ep.episodeNumber}`);
        if (!tvdbId) continue;
        const off = officialById.get(tvdbId);
        const scene = dvdById.get(tvdbId);
        const set: { absoluteNumber?: number | null; sceneSeasonNumber?: number | null; sceneEpisodeNumber?: number | null } = {};
        if (off?.absoluteNumber != null && ep.absoluteNumber !== off.absoluteNumber) set.absoluteNumber = off.absoluteNumber;
        if (scene?.seasonNumber != null && ep.sceneSeasonNumber !== scene.seasonNumber) set.sceneSeasonNumber = scene.seasonNumber;
        if (scene?.number != null && ep.sceneEpisodeNumber !== scene.number) set.sceneEpisodeNumber = scene.number;
        if (Object.keys(set).length > 0) {
          await this.db.update(schema.episode).set(set).where(eq(schema.episode.id, ep.id));
          updated++;
        }
      }
      if (updated > 0) this.logger.log(`TVDB numbering backfill "${series.title}": updated ${updated} episode(s)`);
    } catch (err) {
      this.logger.warn(`TVDB numbering backfill skipped for "${series.title}": ${(err as Error).message}`);
    }
  }

  /** Best-effort TheTVDB alias backfill: store the series' alternate titles /
   *  abbreviations (from TVDB `aliases`, e.g. AOT/SNK for Attack on Titan) so releases
   *  named with a scene/acronym title can match. Graceful — a TVDB failure is a warn, never
   *  a failure of the refresh. Keeps a previously-set value if TVDB now has no aliases. */
  private async backfillTvdbAliases(series: typeof schema.series.$inferSelect): Promise<void> {
    if (!series.tvdbId) return;
    const tvdb = await this.tvdbProvider();
    try {
      const aliases = await tvdb.seriesAliases(series.tvdbId);
      if (aliases.length > 0) {
        await this.db.update(schema.series).set({ alternateTitles: aliases }).where(eq(schema.series.id, series.id));
      }
    } catch (err) {
      this.logger.warn(`TheTVDB aliases backfill skipped for "${series.title}": ${(err as Error).message}`);
    }
  }

  /** Refresh up to `limit` series that have no episodes yet (bounded job). */
  async refreshMissing(limit = 5): Promise<{ refreshed: number }> {
    const series = await this.db.select().from(schema.series).limit(limit);
    let refreshed = 0;
    for (const s of series) {
      try { await this.refreshSeries(s.id); refreshed++; }
      catch (err) { this.logger.warn(`metadata refresh skipped ${s.title}: ${(err as Error).message}`); }
    }
    return { refreshed };
  }

  /** Browse TMDB trending/popular/upcoming/top-rated lists, flagged against the local library. */
  async discover(mediaType: "movie" | "series", category: DiscoverCategory, page = 1) {
    const p = await this.provider();
    if (!p) throw new ApiError({ code: "UNPROCESSABLE", message: "metadata.tmdbApiKey is not configured" });
    const result = await p.discover(mediaType, category, page);

    const tmdbIds = result.results.map((r) => r.tmdbId);
    const inLibrary = new Map<number, string>();
    if (tmdbIds.length) {
      const table = mediaType === "movie" ? schema.movie : schema.series;
      const rows = await this.db.select({ id: table.id, tmdbId: table.tmdbId }).from(table).where(inArray(table.tmdbId, tmdbIds));
      for (const r of rows) if (r.tmdbId != null) inLibrary.set(r.tmdbId, r.id);
    }

    return {
      page: result.page,
      totalPages: result.totalPages,
      totalResults: result.totalResults,
      results: result.results.map((r) => ({
        ...r,
        inLibrary: inLibrary.has(r.tmdbId),
        libraryId: inLibrary.get(r.tmdbId) ?? null,
      })),
    };
  }

  /** One-click add from discover: create the title, then best-effort enrich (images/genres/seasons). */
  async addFromDiscover(mediaType: "movie" | "series", tmdbId: number): Promise<{ id: string; created: boolean }> {
    const p = await this.provider();
    if (!p) throw new ApiError({ code: "UNPROCESSABLE", message: "metadata.tmdbApiKey is not configured" });

    if (mediaType === "movie") {
      const existing = await this.db.select({ id: schema.movie.id }).from(schema.movie).where(eq(schema.movie.tmdbId, tmdbId)).limit(1);
      if (existing[0]) return { id: existing[0].id, created: false };
      const details = await p.getDetails("movie", String(tmdbId));
      // Movie automation (roadmap C1) searches anything past its minimum-availability gate.
      // TMDB already tells us whether the film has actually come out — use it, rather than
      // defaulting every Discover-added movie to "announced" (always searchable), which
      // would grab cams for unreleased films the moment automation runs.
      const minimumAvailability = details.releaseDate && new Date(details.releaseDate) > new Date() ? "released" : "announced";
      const created = await this.movies.create({
        title: details.title, tmdbId, overview: details.overview ?? "", releaseDate: details.releaseDate,
        monitored: true, rootFolderPath: "", tags: [], minimumAvailability,
      });
      await this.refreshMovie(created.id).catch((err) => this.logger.warn(`post-add movie enrich failed: ${(err as Error).message}`));
      return { id: created.id, created: true };
    }

    const existingSeries = await this.db.select({ id: schema.series.id }).from(schema.series).where(eq(schema.series.tmdbId, tmdbId)).limit(1);
    if (existingSeries[0]) return { id: existingSeries[0].id, created: false };
    const tvdbId = await p.tvdbIdForTmdb(tmdbId);
    if (!tvdbId) throw new ApiError({ code: "UNPROCESSABLE", message: "Could not resolve a TVDB id for this series from TMDB" });
    const details = await p.getDetails("series", String(tmdbId));
    const createdSeries = await this.series.create({
      title: details.title, tvdbId, tmdbId, overview: details.overview ?? "", firstAirYear: details.year,
      monitored: true, rootFolderPath: "", seriesType: "standard", tags: [],
    });
    await this.refreshSeries(createdSeries.id).catch((err) => this.logger.warn(`post-add series enrich failed: ${(err as Error).message}`));
    return { id: createdSeries.id, created: true };
  }
}
