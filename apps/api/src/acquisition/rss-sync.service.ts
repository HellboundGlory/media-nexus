// SPDX-License-Identifier: MIT
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, or, sql } from "drizzle-orm";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import {
  episodeQueryTag, parseEpisodeRelease, titleMatches, pickBest,
} from "@medianexus/domain";
import type { Release } from "@medianexus/domain";
import { IndexersService } from "../indexers/indexers.service";
import { SeriesService } from "../series/series.service";
import { MoviesService, type WantedMovie } from "../movies/movies.service";
import { EventsService } from "../events/events.service";
import { EventTypes } from "@medianexus/events";

/**
 * RSS sync: for monitored movies and episodes that are missing, search configured
 * indexers and auto-grab the best matching release — the "new title appears and gets
 * downloaded automatically" behavior. One job (`media.rssSync`), one service, for both
 * media types (roadmap C1 extended this from series-only to also cover movies — the job
 * was always registered under a media-neutral name and `compat.service.ts` already
 * dispatched it for Radarr-compat movie-search commands, which were a silent no-op until
 * now). Bounded per run, duplicate-safe.
 */
@Injectable()
export class RssSyncService {
  private readonly logger = new Logger(RssSyncService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly indexers: IndexersService,
    private readonly series: SeriesService,
    private readonly movies: MoviesService,
    private readonly events: EventsService,
  ) {}

  async run(opts: { maxSeries?: number; perSeries?: number; maxMovies?: number } = {}): Promise<{
    scannedSeries: number; scannedMovies: number;
    grabbed: number; grabbedMovies: number; grabbedSeries: number;
    skipped: number;
  }> {
    const movieResult = await this.runMovies(opts.maxMovies ?? 5);
    const seriesResult = await this.runSeries(opts.maxSeries ?? 5, opts.perSeries ?? 2);
    const result = {
      scannedSeries: seriesResult.scannedSeries,
      scannedMovies: movieResult.scannedMovies,
      grabbed: movieResult.grabbed + seriesResult.grabbed,
      grabbedMovies: movieResult.grabbed,
      grabbedSeries: seriesResult.grabbed,
      skipped: movieResult.skipped + seriesResult.skipped,
    };
    this.logger.log(
      `rssSync: movies(scanned=${result.scannedMovies} grabbed=${result.grabbedMovies}) ` +
      `series(scanned=${result.scannedSeries} grabbed=${result.grabbedSeries}) skipped=${result.skipped}`,
    );
    return result;
  }

  // ---------- movies ----------

  private async runMovies(maxMovies: number): Promise<{ scannedMovies: number; grabbed: number; skipped: number }> {
    const wanted = await this.movies.wantedMissing(500);
    let scannedMovies = 0;
    let grabbed = 0;
    let skipped = 0;

    for (const movie of wanted) {
      if (scannedMovies >= maxMovies) break;
      if (await this.hasActiveQueue("movie", movie.id)) { skipped++; continue; }
      if (await this.grabbedRecently("movie", movie.id)) { skipped++; continue; }

      scannedMovies++;
      if (await this.tryGrabMovie(movie)) grabbed++; else skipped++;
    }

    return { scannedMovies, grabbed, skipped };
  }

  private async tryGrabMovie(movie: WantedMovie): Promise<boolean> {
    const year = movie.releaseDate ? Number(movie.releaseDate.slice(0, 4)) : undefined;
    const query = year && !Number.isNaN(year) ? `${movie.title} ${year}` : movie.title;
    const res = await this.indexers.search({ mediaType: "movie", mediaId: movie.id, query, limit: 50 });
    if (res.releases.length === 0) return false;

    const candidates = res.releases.filter((r) => this.matchesMovie(r, movie.title, year));
    const best = pickBest(candidates.map((r) => r.decision));
    if (!best) return false;

    try {
      await this.indexers.grab({ mediaType: "movie", mediaId: movie.id, releaseId: best.release.id, indexerId: best.release.indexerId, release: best.release });
      return true;
    } catch (err) {
      this.logger.warn(`auto-grab failed for ${movie.title}${year ? ` (${year})` : ""}: ${(err as Error).message}`);
      this.events.publish(EventTypes.DownloadClientFailed, { movieId: movie.id, error: (err as Error).message });
      return false;
    }
  }

  /** A movie release has no SxxExx to match on — use the year parseEpisodeRelease()'s
   *  "probably a movie" fallback already extracts, tolerant of +/-1 for festival/regional
   *  release-date drift across a calendar-year boundary, plus a real title match. */
  private matchesMovie(r: Release, title: string, year: number | undefined): boolean {
    const m = parseEpisodeRelease(r.title);
    if (year !== undefined && m.year !== undefined && Math.abs(m.year - year) > 1) return false;
    return titleMatches(m.seriesTitle, title);
  }

  // ---------- series ----------

  private async runSeries(maxSeries: number, perSeries: number): Promise<{ scannedSeries: number; grabbed: number; skipped: number }> {
    const wanted = await this.series.wantedMissing(500);
    // group wanted episodes by series (keep air-dated first)
    const bySeries = new Map<string, typeof wanted>();
    for (const ep of wanted) {
      const list = bySeries.get(ep.seriesId) ?? [];
      list.push(ep);
      bySeries.set(ep.seriesId, list);
    }

    let scannedSeries = 0;
    let grabbed = 0;
    let skipped = 0;

    for (const [seriesId, eps] of bySeries) {
      if (scannedSeries >= maxSeries) break;
      if (await this.hasActiveQueue("series", seriesId)) { skipped += eps.length; continue; }
      const firstTarget = eps[0];
      if (await this.grabbedRecently("series", seriesId, (releaseTitle) => {
        const m = parseEpisodeRelease(releaseTitle);
        return m.season === firstTarget.seasonNumber && m.episodes.includes(firstTarget.episodeNumber);
      })) { skipped += eps.length; continue; }

      scannedSeries++;
      const seriesTitle = eps[0].seriesTitle;
      const targets = eps.slice(0, perSeries);
      for (const target of targets) {
        const didGrab = await this.tryGrabEpisode(seriesId, seriesTitle, target.seasonNumber, target.episodeNumber);
        if (didGrab) { grabbed++; if (await this.hasActiveQueue("series", seriesId)) break; }
        else skipped++;
      }
    }

    return { scannedSeries, grabbed, skipped };
  }

  private async tryGrabEpisode(seriesId: string, seriesTitle: string, season: number, episode: number): Promise<boolean> {
    const tag = episodeQueryTag(season, episode);
    const query = `${seriesTitle} ${tag}`;
    const res = await this.indexers.search({ mediaType: "series", mediaId: seriesId, query, limit: 50 });
    if (res.releases.length === 0) return false;

    // Filter to releases whose title actually contains the target episode (SxxExx
    // match), then let the decision engine's verdicts — already attached to each
    // release by search() — pick the best *approved* candidate. A higher-quality
    // release that's blocklisted, disallowed by the profile, or not an upgrade over an
    // existing file loses to a worse-but-approved one, instead of always winning on
    // raw quality the way the old compareQuality-only bestRelease() did.
    const candidates = res.releases.filter((r) => this.matchesTarget(r, season, episode));
    const best = pickBest(candidates.map((r) => r.decision));
    if (!best) return false;

    try {
      await this.indexers.grab({ mediaType: "series", mediaId: seriesId, releaseId: best.release.id, indexerId: best.release.indexerId, release: best.release });
      return true;
    } catch (err) {
      this.logger.warn(`auto-grab failed for ${seriesTitle} ${tag}: ${(err as Error).message}`);
      this.events.publish(EventTypes.DownloadClientFailed, { seriesId, error: (err as Error).message });
      return false;
    }
  }

  private matchesTarget(r: Release, season: number, episode: number): boolean {
    const m = parseEpisodeRelease(r.title);
    if (m.season !== season) return false;
    if (!m.episodes.includes(episode)) return false;
    // series name sanity (only when our parser extracted something)
    if (m.seriesTitle && !titleMatches(m.seriesTitle, r.indexerName) && m.confidence === 1) {
      // tolerate unknown indexer name mismatch; rely on SxxExx which is strong
    }
    return true;
  }

  // ---------- shared: active-queue / recently-grabbed dedupe ----------

  private async hasActiveQueue(mediaType: "movie" | "series", mediaId: string): Promise<boolean> {
    const rows = await this.db.select({ id: schema.downloadQueueEntry.id }).from(schema.downloadQueueEntry)
      .where(and(
        eq(schema.downloadQueueEntry.mediaType, mediaType),
        eq(schema.downloadQueueEntry.mediaId, mediaId),
        or(
          eq(schema.downloadQueueEntry.status, "queued"),
          eq(schema.downloadQueueEntry.status, "downloading"),
          eq(schema.downloadQueueEntry.status, "paused"),
          eq(schema.downloadQueueEntry.status, "importing"),
        ),
      )).limit(1);
    return rows.length > 0;
  }

  /** `matches` narrows which grabbed release counts — series passes a season/episode
   *  predicate (a series can have several distinct wanted targets); a movie has exactly
   *  one target, so `(mediaType, mediaId, action="grabbed", within 6h)` alone is already
   *  unambiguous and the default `() => true` is sufficient. */
  private async grabbedRecently(
    mediaType: "movie" | "series",
    mediaId: string,
    matches: (releaseTitle: string) => boolean = () => true,
  ): Promise<boolean> {
    const cutoff = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
    const rows = await this.db.select().from(schema.historyEntry)
      .where(and(
        eq(schema.historyEntry.mediaType, mediaType),
        eq(schema.historyEntry.mediaId, mediaId),
        eq(schema.historyEntry.action, "grabbed"),
        sql`${schema.historyEntry.createdAt} >= ${cutoff}`,
      )).limit(20);
    for (const r of rows) {
      const data = (r.data ?? {}) as { releaseTitle?: string };
      if (data.releaseTitle && matches(data.releaseTitle)) return true;
    }
    return false;
  }
}
