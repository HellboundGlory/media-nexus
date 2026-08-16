// SPDX-License-Identifier: MIT
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { ApiError, newEntityId } from "@medianexus/shared";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import { ConfigService } from "../system/config.service";
import { TmdbProvider, TvdbProvider, DEFAULT_TMDB_WORKER_URL, type TvdbEpisodeRecord } from "@medianexus/integrations";
import type { MediaSummary, DiscoverCategory } from "@medianexus/integrations";
import { MoviesService } from "../movies/movies.service";
import { SeriesService } from "../series/series.service";
import { AutoTagsService } from "../auto-tags/auto-tags.service";

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
    private readonly autoTags: AutoTagsService,
  ) {}

  async provider(): Promise<TmdbProvider> {
    const c = await this.config.get();
    const apiKey = c["metadata.tmdbApiKey"]?.trim() || undefined;
    // TMDBPROXY (roadmap P3): additive fallback mirroring TvdbProvider — an own key goes straight
    // to the real TMDB API; no key uses the shared Cloudflare proxy (/tmdb), which injects the real
    // key. An explicit `metadata.tmdbBaseUrl` overrides either default. TMDB metadata is thus always
    // available; never "not configured".
    const defaultBase = apiKey ? "https://api.themoviedb.org/3" : DEFAULT_TMDB_WORKER_URL;
    const baseUrl = (c["metadata.tmdbBaseUrl"]?.trim() || defaultBase).replace(/\/$/, "");
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
    return p.search(query, mediaType);
  }

  async refreshMovie(movieId: string): Promise<{ updated: boolean; title?: string }> {
    const p = await this.provider();
    const movie = await this.db.select().from(schema.movie).where(eq(schema.movie.id, movieId)).limit(1);
    if (!movie[0]) throw ApiError.notFound("movie", movieId);
    if (!movie[0].tmdbId) throw new ApiError({ code: "UNPROCESSABLE", message: "movie has no tmdbId" });
    const d = await p.getDetails("movie", String(movie[0].tmdbId));
    const now = new Date().toISOString();
    const releaseDate = d.releaseDate ?? movie[0].releaseDate;
    const tags = await this.autoTags.appliedTags({
      tags: movie[0].tags ?? [],
      genres: d.genres ?? [],
      status: movie[0].status,
      monitored: movie[0].monitored,
      rootFolderPath: movie[0].rootFolderPath ?? "",
      qualityProfileId: movie[0].qualityProfileId,
      year: releaseDate ? Number(releaseDate.slice(0, 4)) : null,
    });
    await this.db.update(schema.movie).set({
      overview: d.overview ?? movie[0].overview ?? "",
      genres: d.genres ?? [],
      images: d.images ?? [],
      releaseDate,
      // Detail-page metadata (DETAILPAGE-BE1) — new nullable columns threaded from MediaSummary.
      certification: d.certification ?? null,
      runtime: d.runtime ?? null,
      studio: d.studio ?? null,
      inCinemas: d.inCinemas ?? null,
      digitalRelease: d.digitalRelease ?? null,
      physicalRelease: d.physicalRelease ?? null,
      trailerId: d.trailerId ?? null,
      tmdbRating: d.rating ?? null,
      // Collection (DETAILPAGE-BE3) — two nullable columns, absent = null.
      collectionTmdbId: d.collectionTmdbId ?? null,
      collectionName: d.collectionName ?? null,
      tags,
      updatedAt: now,
      lastRefreshedAt: now,
    }).where(eq(schema.movie.id, movieId));
    // Cast & crew (DETAILPAGE-BE2): replace this title's credit rows with the fresh set. Guarded
    // on the optional contract method (only TMDB implements it). A credits failure is a warn, not
    // a failure of the metadata refresh itself — same best-effort posture as the TVDB backfills.
    await this.replaceCredits(p, "movie", String(movie[0].tmdbId), movieId).catch((err) =>
      this.logger.warn(`credits refresh skipped for "${d.title}": ${(err as Error).message}`));
    return { updated: true, title: d.title };
  }

  /** Replace a title's media_credit rows with a fresh fetch (DETAILPAGE-BE2). Cast is stored in
   *  full; crew is the provider's curated key-jobs subset. Delete-then-insert is a replace, so
   *  re-refreshing a title never duplicates rows. */
  private async replaceCredits(p: TmdbProvider, mediaType: "movie" | "series", externalId: string, localId: string): Promise<void> {
    const credits = await p.getCredits?.(mediaType, externalId);
    if (!credits) return; // provider doesn't implement credits — nothing to do
    await this.db.delete(schema.mediaCredit)
      .where(and(eq(schema.mediaCredit.mediaType, mediaType), eq(schema.mediaCredit.mediaId, localId)));
    if (credits.cast.length + credits.crew.length === 0) return;
    const rows = [
      ...credits.cast.map((c) => ({
        id: newEntityId("credit"), mediaType, mediaId: localId, role: "cast" as const,
        personName: c.name, character: c.character ?? null, job: null, department: null,
        sortOrder: c.order ?? null, profileUrl: c.profileUrl ?? null,
      })),
      ...credits.crew.map((c) => ({
        id: newEntityId("credit"), mediaType, mediaId: localId, role: "crew" as const,
        personName: c.name, character: null, job: c.job ?? null, department: c.department ?? null,
        sortOrder: null, profileUrl: c.profileUrl ?? null,
      })),
    ];
    await this.db.insert(schema.mediaCredit).values(rows);
  }

  async refreshSeries(seriesId: string): Promise<{ updated: boolean; title?: string; seasons: number; episodes: number }> {
    const p = await this.provider();
    const series = await this.db.select().from(schema.series).where(eq(schema.series.id, seriesId)).limit(1);
    if (!series[0]) throw ApiError.notFound("series", seriesId);

    const tmdbId = series[0].tvdbId ? await p.tmdbIdForTvdb(series[0].tvdbId) : null;
    if (!tmdbId) throw new ApiError({ code: "UNPROCESSABLE", message: "could not resolve a TMDB id for this series (needs tvdbId)" });

    const d = await p.getDetails("series", tmdbId);
    const seasons = await p.seriesSeasons(Number(tmdbId));
    const now = new Date().toISOString();
    const tags = await this.autoTags.appliedTags({
      tags: series[0].tags ?? [],
      genres: d.genres ?? [],
      status: series[0].status,
      monitored: series[0].monitored,
      rootFolderPath: series[0].rootFolderPath ?? "",
      qualityProfileId: series[0].qualityProfileId,
      year: d.year ?? series[0].firstAirYear,
      network: series[0].network,
      seriesType: series[0].seriesType,
    });
    await this.db.update(schema.series).set({
      overview: d.overview ?? series[0].overview ?? "",
      genres: d.genres ?? [],
      images: d.images ?? [],
      firstAirYear: d.year ?? series[0].firstAirYear,
      // Persist the resolved TMDB id back onto the row — but only when the row has none yet.
      // Without the backfill at all, a series added via TVDB keeps tmdbId null forever, which in
      // turn hides the DetailHeader TMDb link (DETAILPAGE-FE1). It must NOT blindly overwrite an
      // existing id though: series.tmdb_id is UNIQUE, and a refresh that resolves a conflicting id
      // (e.g. two rows mapping to one TMDB title) would throw a unique-constraint error. A
      // pre-existing id is already correct (derived from the same tvdbId), so leave it alone.
      // tmdbId here is a string from tmdbIdForTvdb(); the column is an integer.
      tmdbId: series[0].tmdbId ?? Number(tmdbId),
      // Detail-page metadata (DETAILPAGE-BE1) — new nullable columns threaded from MediaSummary.
      certification: d.certification ?? null,
      runtime: d.runtime ?? null,
      trailerId: d.trailerId ?? null,
      tmdbRating: d.rating ?? null,
      tags,
      updatedAt: now,
      lastRefreshedAt: now,
    }).where(eq(schema.series.id, seriesId));
    // Cast & crew (DETAILPAGE-BE2): replace this title's credit rows with the fresh set. Same
    // best-effort posture as refreshMovie — a credits failure is a warn, not a refresh failure.
    await this.replaceCredits(p, "series", String(tmdbId), seriesId).catch((err) =>
      this.logger.warn(`credits refresh skipped for "${d.title}": ${(err as Error).message}`));

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

  /**
   * Refresh up to `limit` titles (movies AND series) that have gone longest without a metadata
   * refresh (roadmap P3, gap report D5). Selection is ordered by `lastRefreshedAt` ASC across
   * both tables, nulls first: never-refreshed rows (NULL) sort ahead of everything, and a
   * successful refresh bumps `lastRefreshedAt` to now, pushing a row to the back of the queue for
   * the next run — so the job rotates through the whole library instead of repeatedly re-selecting
   * the same first N. A dedicated column rather than `updatedAt` (which is also bumped by edits,
   * imports and library scans — a recently *used* title would otherwise be wrongly deprioritized).
   * No `monitored` filter: this is a metadata-completeness net rather than an acquisition pass, so
   * unmonitored titles are refreshed too. A failing row (e.g. no tmdbId/tvdbId -> UNPROCESSABLE) is
   * caught, logged, and skipped — one bad row never aborts the batch.
   */
  async refreshMissing(limit = 5): Promise<{ refreshed: number }> {
    // Order by `lastRefreshedAt` ASC with NULLs first (never-refreshed). Postgres sorts NULLs
    // LAST on ASC by default while SQLite puts them first, so pin `NULLS FIRST` on the pg branch.
    const [movies, series] = await Promise.all([
      this.db.select().from(schema.movie)
        .orderBy(this.db.dbDialect === "postgres" ? sql`${schema.movie.lastRefreshedAt} asc nulls first` : sql`${schema.movie.lastRefreshedAt} asc`)
        .limit(limit),
      this.db.select().from(schema.series)
        .orderBy(this.db.dbDialect === "postgres" ? sql`${schema.series.lastRefreshedAt} asc nulls first` : sql`${schema.series.lastRefreshedAt} asc`)
        .limit(limit),
    ]);
    // Merge both candidate sets, oldest-lastRefreshedAt first, keep the `limit` oldest overall.
    // ISO timestamps sort lexicographically == chronologically; null/"no refresh yet" sorts first.
    const candidates = [
      ...movies.map((m) => ({ kind: "movie" as const, id: m.id, title: m.title, lastRefreshedAt: m.lastRefreshedAt })),
      ...series.map((s) => ({ kind: "series" as const, id: s.id, title: s.title, lastRefreshedAt: s.lastRefreshedAt })),
    ].sort((a, b) => (a.lastRefreshedAt ?? "").localeCompare(b.lastRefreshedAt ?? "")).slice(0, limit);

    let refreshed = 0;
    for (const c of candidates) {
      try {
        if (c.kind === "movie") await this.refreshMovie(c.id);
        else await this.refreshSeries(c.id);
        refreshed++;
      } catch (err) {
        this.logger.warn(`metadata refresh skipped ${c.title}: ${(err as Error).message}`);
      }
    }
    return { refreshed };
  }

  /** Browse TMDB trending/popular/upcoming/top-rated lists, flagged against the local library. */
  async discover(mediaType: "movie" | "series", category: DiscoverCategory, page = 1) {
    const p = await this.provider();
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
