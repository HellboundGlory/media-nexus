// SPDX-License-Identifier: MIT
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
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
import type { SeriesType } from "@medianexus/domain";

/** A /metadata/search result annotated against the local library (UNI-029 pass 2). The provider
 *  (`MediaSummary`) stays DB-agnostic; in-library membership is enriched here, not in
 *  TmdbProvider — same discipline as `discover()`. */
export interface SearchResult extends MediaSummary {
  inLibrary: boolean;
  libraryId: string | null;
}

/** Optional non-smart fields the add flow can override (QUALITYPROFILES-1 / UNI-014). Every
 *  field defaults to the same literal Discovery previously hardcoded ("" / [] / "standard" /
 *  monitored:true), so callers that don't pass overrides get identical behaviour — only a field
 *  actually being present changes anything, and that's the gap being closed. */
export interface DiscoverAddOverrides {
  qualityProfileId?: string;
  rootFolderPath?: string;
  tags?: string[];
  seriesType?: SeriesType;
  monitored?: boolean;
  /** UNI-021: explicit caller minimum-availability wins over the TMDB-release-date-derived
   *  default. Missing (undefined) keeps the existing smart default exactly as before. */
  minimumAvailability?: "announced" | "in_cinemas" | "released" | "deleted";
}

/**
 * Metadata import (metadata): movies are TMDB-driven; series are TheTVDB-driven (real Sonarr
 * parity — one canonical record per show, plus the absolute/scene numbering TMDB lacks) and
 * auto-populate seasons + episodes (M2 previously needed manual episode seeding).
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

  async lookup(query: string, mediaType: "movie" | "series"): Promise<SearchResult[]> {
    // Series searches TheTVDB (the source real Sonarr searches; TMDB splits continuations into
    // duplicate ids), movies stay TMDB. `externalId` is therefore in the provider's native space:
    // tmdbId for movies, tvdbId for series — the in-library annotation must match on that column.
    const results = mediaType === "movie"
      ? await (await this.provider()).search(query, mediaType)
      : await (await this.tvdbProvider()).search(query);
    // Annotate in-library membership with one batched query (same discipline as `discover()`) so
    // the Add search modal can show "In library"/"+ Add" correctly for already-added titles.
    const externalIds = results.map((r) => Number(r.externalId)).filter((n) => Number.isFinite(n));
    const inLibrary = new Map<number, string>();
    if (externalIds.length) {
      if (mediaType === "movie") {
        const rows = await this.db.select({ id: schema.movie.id, external: schema.movie.tmdbId }).from(schema.movie).where(inArray(schema.movie.tmdbId, externalIds));
        for (const r of rows) if (r.external != null) inLibrary.set(r.external, r.id);
      } else {
        const rows = await this.db.select({ id: schema.series.id, external: schema.series.tvdbId }).from(schema.series).where(inArray(schema.series.tvdbId, externalIds));
        for (const r of rows) if (r.external != null) inLibrary.set(r.external, r.id);
      }
    }
    return results.map((r) => {
      const id = Number(r.externalId);
      return { ...r, inLibrary: inLibrary.has(id), libraryId: inLibrary.get(id) ?? null };
    });
  }

  /** Fetch a TMDB collection's header + parts, annotating each part with whether it's already in
   *  the library (UNI-021). The single shared computation used by both the movie-add upsert hook
   *  below and CollectionsService.sync() — the provider knows nothing about the library, so the
   *  batched ownership check happens here, like `discover()`/`lookup()`. */
  async getCollectionInfo(tmdbId: number): Promise<{
    tmdbId: number;
    name: string;
    overview: string | null;
    images: { coverType: string; url: string }[];
    parts: { tmdbId: number; title: string; releaseDate: string | null; images: { coverType: string; url: string }[]; inLibrary: boolean; libraryId: string | null }[];
  }> {
    const p = await this.provider();
    const data = await p.getCollection(tmdbId);
    const tmdbIds = data.parts.map((part) => part.tmdbId);
    const owned = new Map<number, string>();
    if (tmdbIds.length) {
      const rows = await this.db.select({ id: schema.movie.id, tmdbId: schema.movie.tmdbId }).from(schema.movie).where(inArray(schema.movie.tmdbId, tmdbIds));
      for (const r of rows) if (r.tmdbId != null) owned.set(r.tmdbId, r.id);
    }
    return {
      tmdbId: data.tmdbId,
      name: data.name,
      overview: data.overview ?? null,
      images: data.images,
      parts: data.parts.map((part) => ({
        tmdbId: part.tmdbId, title: part.title, releaseDate: part.releaseDate ?? null, images: part.images,
        inLibrary: owned.has(part.tmdbId), libraryId: owned.get(part.tmdbId) ?? null,
      })),
    };
  }

  /** Upsert a `collection` row the first time a movie with that collectionTmdbId is created or
   *  refreshed. New rows start unmonitored (decision 1); parts are populated from a real TMDB
   *  `/collection/{id}` fetch. Best-effort — a failure here warns, never fails the movie refresh. */
  private async ensureCollectionFromMovie(tmdbId: number, name: string): Promise<void> {
    const existing = await this.db.select({ id: schema.collection.id }).from(schema.collection).where(eq(schema.collection.tmdbId, tmdbId)).limit(1);
    if (existing[0]) return; // already tracked — the collection sync job keeps its parts fresh
    const info = await this.getCollectionInfo(tmdbId);
    const now = new Date().toISOString();
    await this.db.insert(schema.collection).values({
      id: newEntityId("col"), tmdbId: info.tmdbId, name: info.name || name || "",
      overview: info.overview, images: info.images, monitored: false, qualityProfileId: null,
      rootFolderPath: "", minimumAvailability: "released", searchOnAdd: false,
      parts: info.parts, lastSyncAt: now, createdAt: now, updatedAt: now,
    }).onConflictDoNothing();
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
      // TMDB's real lifecycle status (SERIESSTATUS-2), verbatim; keep the DB value if TMDB gave
      // nothing this time (never regress a real value to null).
      status: d.status ?? movie[0].status,
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
    // UNI-021: if this movie belongs to a TMDB collection and the collection isn't tracked yet,
    // upsert it (unmonitored, parts populated) — best-effort, a failure warns not fails the refresh.
    if (d.collectionTmdbId != null) {
      await this.ensureCollectionFromMovie(d.collectionTmdbId, d.collectionName ?? "").catch(
        (err) => this.logger.warn(`collection upsert failed for movie ${movieId}: ${(err as Error).message}`),
      );
    }
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

  /**
   * Refresh a series from TheTVDB, its primary metadata source (real Sonarr parity): overview,
   * images, genres, status, certification and runtime plus the full season/episode rebuild come
   * from TvdbProvider. The row's tvdbId IS the primary id, so there is no TMDB-resolution gate —
   * a TVDB-native series refreshes with no TMDB dependency at all. series.tmdbId is only
   * best-effort backfilled (TVDB remoteIds first, legacy TMDB reverse-lookup as fallback)
   * because the DetailHeader TMDb link (DETAILPAGE-FE1) and cast/crew credits (DETAILPAGE-BE2,
   * still TMDB-sourced) read it; both backfill paths are strictly non-fatal.
   */
  async refreshSeries(seriesId: string): Promise<{ updated: boolean; title?: string; seasons: number; episodes: number }> {
    const p = await this.provider();
    const tvdb = await this.tvdbProvider();
    const series = await this.db.select().from(schema.series).where(eq(schema.series.id, seriesId)).limit(1);
    if (!series[0]) throw ApiError.notFound("series", seriesId);
    if (!series[0].tvdbId) throw new ApiError({ code: "UNPROCESSABLE", message: "series has no tvdbId" });

    const d = await tvdb.getDetails(String(series[0].tvdbId));
    const seasons = await tvdb.seriesSeasons(String(series[0].tvdbId));

    // Best-effort tmdbId backfill (never fails the refresh): prefer reading it straight off the
    // extended record's remoteIds; fall back to the TMDB reverse-lookup only when the row has no
    // id yet AND remoteIds came up empty. It is written below ONLY when the row has none:
    // series.tmdb_id is UNIQUE, and overwriting a pre-existing (already correct) id with a
    // conflicting one would throw on the constraint.
    let resolvedTmdbId: number | null = d.tmdbId ?? null;
    if (resolvedTmdbId == null && !series[0].tmdbId) {
      resolvedTmdbId = await p.tmdbIdForTvdb(series[0].tvdbId)
        .then((s) => (Number.isFinite(Number(s)) ? Number(s) : null))
        .catch((err) => {
          this.logger.warn(`TMDB reverse-lookup skipped for "${d.title}": ${(err as Error).message}`);
          return null;
        });
    }

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
      // TheTVDB's real lifecycle status verbatim ("Ended"/"Continuing"/...); keep the DB value if
      // TVDB gave nothing this time (never regress a real value to null).
      status: d.status ?? series[0].status,
      // Detail-page metadata (DETAILPAGE-BE1). Certification/runtime follow the same never-regress
      // rule as status: a sparse TVDB record must not blank what an earlier refresh stored.
      // tmdbRating/trailerId are left untouched: TVDB's `score` is a popularity count, not a 0-10
      // rating, and its trailers are not mapped — overwriting would destroy real TMDB values.
      certification: d.certification ?? series[0].certification,
      runtime: d.runtime ?? series[0].runtime,
      tags,
      updatedAt: now,
      lastRefreshedAt: now,
    }).where(eq(schema.series.id, seriesId));
    // Backfill-only write of the resolved TMDB id (see the note above), as its own statement so a
    // conflict can never fail the refresh: series.tmdb_id is UNIQUE, and two TVDB records can
    // legitimately name the same TMDB id in their remoteIds — the first row keeps it, this one
    // just logs and moves on.
    if (series[0].tmdbId == null && resolvedTmdbId != null) {
      const clash = await this.db.select({ id: schema.series.id }).from(schema.series)
        .where(and(eq(schema.series.tmdbId, resolvedTmdbId), ne(schema.series.id, seriesId))).limit(1);
      if (clash[0]) {
        this.logger.warn(`tmdbId backfill skipped for "${d.title}": TMDB id ${resolvedTmdbId} is already claimed by series ${clash[0].id}`);
      } else {
        await this.db.update(schema.series).set({ tmdbId: resolvedTmdbId }).where(eq(schema.series.id, seriesId));
      }
    }
    // Cast & crew stay TMDB-sourced (DETAILPAGE-BE2; TVDB has no credits endpoint in scope).
    // Skipped outright for pure-TVDB records with no tmdbId anywhere — nothing to fetch from.
    const creditsTmdbId = series[0].tmdbId ?? resolvedTmdbId;
    if (creditsTmdbId != null) {
      await this.replaceCredits(p, "series", String(creditsTmdbId), seriesId).catch((err) =>
        this.logger.warn(`credits refresh skipped for "${d.title}": ${(err as Error).message}`));
    }

    // upsert seasons + episodes idempotently (from the assembled TVDB official ordering)
    let seasonCount = 0;
    let episodeCount = 0;
    for (const season of seasons) {
      const existing = await this.db.select({ id: schema.season.id }).from(schema.season)
        .where(and(eq(schema.season.seriesId, seriesId), eq(schema.season.seasonNumber, season.seasonNumber))).limit(1);
      let seasonId = existing[0]?.id ?? null;
      if (!seasonId) {
        seasonId = `sea_${seriesId}_${season.seasonNumber}`;
        await this.db.insert(schema.season).values({ id: seasonId, seriesId, seasonNumber: season.seasonNumber, monitored: true });
        seasonCount++;
      }
      for (const ep of season.episodes) {
        const epId = `ep_${seriesId}_${season.seasonNumber}_${ep.episodeNumber}`;
        const exists = await this.db.select({ id: schema.episode.id }).from(schema.episode).where(eq(schema.episode.id, epId)).limit(1);
        if (exists[0]) {
          // EPISODEDETAIL-1: keep a re-refreshed episode's episode_type current — the insert-only
          // loop would otherwise leave already-imported episodes with null episode_type forever
          // (and thus no Finale badge) after this migration. Update only when the value changed,
          // matching the TVDB numbering backfill's write-if-different discipline below.
          if (ep.episodeType != null) {
            const row = await this.db.select({ episodeType: schema.episode.episodeType }).from(schema.episode).where(eq(schema.episode.id, epId)).limit(1);
            if (row[0]?.episodeType !== ep.episodeType) {
              await this.db.update(schema.episode).set({ episodeType: ep.episodeType }).where(eq(schema.episode.id, epId));
            }
          }
          continue;
        }
        await this.db.insert(schema.episode).values({
          id: epId, seriesId, seasonId, episodeNumber: ep.episodeNumber, title: ep.name ?? "",
          overview: ep.overview ?? "", airDateUtc: ep.airDate ?? null, episodeType: ep.episodeType ?? null,
          monitored: true, hasFile: false,
        });
        episodeCount++;
      }
    }
    this.logger.log(`metadata refresh "${series[0].title}": +${seasonCount} seasons +${episodeCount} episodes`);

    // Best-effort TheTVDB numbering backfill (roadmap P2, gap D8): fill `sceneSeasonNumber` /
    // `sceneEpisodeNumber` from the DVD ordering (and absolute numbers for any rows the upsert
    // loop above didn't just create). Strictly additive and non-fatal — a TVDB failure must never
    // fail the refresh (which already succeeded above).
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

  /**
   * One-click add from discover/search: create the title, then best-effort enrich
   * (images/genres/seasons). `overrides` (QUALITYPROFILES-1) carry the user's add-modal choices —
   * quality profile, root folder, tags, series type — through to the create; the
   * TMDB-release-date-derived minimumAvailability default stays non-overridable (a deliberate,
   * existing smart default).
   *
   * `source` discriminates the series branch's id space (TVDB migration): the Add Series search
   * modal passes `source: "tvdb"` and a tvdbId directly; Discover's TMDB-sourced trending-TV add
   * (and every pre-existing caller, via the default) passes a tmdbId that is resolved to its
   * TheTVDB record first — throwing UNPROCESSABLE when TVDB has none, exactly as before.
   */
  async addFromDiscover(
    mediaType: "movie" | "series",
    externalId: number,
    overrides: DiscoverAddOverrides = {},
    source: "tmdb" | "tvdb" = "tmdb",
  ): Promise<{ id: string; created: boolean }> {
    const p = await this.provider();

    if (mediaType === "movie") {
      const existing = await this.db.select({ id: schema.movie.id }).from(schema.movie).where(eq(schema.movie.tmdbId, externalId)).limit(1);
      if (existing[0]) return { id: existing[0].id, created: false };
      const details = await p.getDetails("movie", String(externalId));
      // Movie automation (roadmap C1) searches anything past its minimum-availability gate.
      // TMDB already tells us whether the film has actually come out — use it, rather than
      // defaulting every Discover-added movie to "announced" (always searchable), which
      // would grab cams for unreleased films the moment automation runs. An explicit caller
      // override (e.g. a collection's minimumAvailability, UNI-021) wins; the smart TMDB
      // default stays the fallback when nothing is passed.
      const minimumAvailability = overrides.minimumAvailability
        ?? (details.releaseDate && new Date(details.releaseDate) > new Date() ? "released" : "announced");
      const created = await this.movies.create({
        title: details.title, tmdbId: externalId, overview: details.overview ?? "", releaseDate: details.releaseDate,
        monitored: overrides.monitored ?? true, rootFolderPath: overrides.rootFolderPath ?? "", tags: overrides.tags ?? [],
        qualityProfileId: overrides.qualityProfileId, minimumAvailability,
      });
      await this.refreshMovie(created.id).catch((err) => this.logger.warn(`post-add movie enrich failed: ${(err as Error).message}`));
      return { id: created.id, created: true };
    }

    const tvdb = await this.tvdbProvider();
    let tvdbId: number;
    let title: string;
    let overview: string | undefined;
    let firstAirYear: number | undefined;
    let tmdbId: number | undefined;

    if (source === "tvdb") {
      // Add Series search: the id IS the tvdbId. Details come from TheTVDB directly; tmdbId is
      // only a best-effort backfill off remoteIds (the refresh re-checks with the reverse lookup).
      const existingByTvdb = await this.db.select({ id: schema.series.id }).from(schema.series).where(eq(schema.series.tvdbId, externalId)).limit(1);
      if (existingByTvdb[0]) return { id: existingByTvdb[0].id, created: false };
      const d = await tvdb.getDetails(String(externalId));
      tvdbId = externalId;
      title = d.title;
      overview = d.overview;
      firstAirYear = d.year;
      tmdbId = d.tmdbId;
    } else {
      // Existing TMDB-sourced path (Discover trending-TV): resolve tmdbId -> tvdbId first; without
      // a TVDB record the season/episode pipeline has no source, so this stays a hard error.
      const existingByTmdb = await this.db.select({ id: schema.series.id }).from(schema.series).where(eq(schema.series.tmdbId, externalId)).limit(1);
      if (existingByTmdb[0]) return { id: existingByTmdb[0].id, created: false };
      const resolved = await p.tvdbIdForTmdb(externalId);
      if (!resolved) throw new ApiError({ code: "UNPROCESSABLE", message: "Could not resolve a TVDB id for this series from TMDB" });
      tvdbId = Number(resolved);
      const d = await p.getDetails("series", String(externalId));
      title = d.title;
      overview = d.overview;
      firstAirYear = d.year;
      tmdbId = externalId;
    }

    // Guard the same clash refreshSeries()'s backfill already guards: TheTVDB's remoteIds are a
    // best-effort tmdbId (source === "tvdb" only — the tmdb-source path's id was just confirmed
    // free by existingByTmdb above), and two TVDB records can legitimately name the same TMDB id.
    // series.tmdb_id is UNIQUE, so an uncaught collision here would surface as a raw DB error
    // instead of a clean one — drop it and let the post-add refresh's own backfill retry instead.
    if (source === "tvdb" && tmdbId != null) {
      const clash = await this.db.select({ id: schema.series.id }).from(schema.series).where(eq(schema.series.tmdbId, tmdbId)).limit(1);
      if (clash[0]) {
        this.logger.warn(`tmdbId ${tmdbId} for "${title}" is already claimed by series ${clash[0].id} — adding without it`);
        tmdbId = undefined;
      }
    }

    const createdSeries = await this.series.create({
      title, tvdbId, tmdbId, overview: overview ?? "", firstAirYear,
      monitored: overrides.monitored ?? true, rootFolderPath: overrides.rootFolderPath ?? "",
      seriesType: overrides.seriesType ?? "standard", tags: overrides.tags ?? [],
      qualityProfileId: overrides.qualityProfileId,
    });
    await this.refreshSeries(createdSeries.id).catch((err) => this.logger.warn(`post-add series enrich failed: ${(err as Error).message}`));
    return { id: createdSeries.id, created: true };
  }
}
