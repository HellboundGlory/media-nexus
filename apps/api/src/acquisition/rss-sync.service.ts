// SPDX-License-Identifier: MIT
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, lt, or, sql } from "drizzle-orm";
import { schema } from "@medianexus/database";
import { newEntityId } from "@medianexus/shared";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import {
  episodeQueryTag, parseEpisodeRelease, titleMatches, pickBest, ACTIVE_QUEUE_STATUSES,
  type SeriesType,
} from "@medianexus/domain";
import type { Release } from "@medianexus/domain";
import { IndexersService } from "../indexers/indexers.service";
import { SeriesService } from "../series/series.service";
import { MoviesService, type WantedMovie } from "../movies/movies.service";
import { DecisionService } from "../decision/decision.service";
import { EventsService } from "../events/events.service";
import { EventTypes } from "@medianexus/events";

/** A single wanted (monitored, missing) episode row as returned by `wantedMissing()`. */
type WantedEpisode = Awaited<ReturnType<SeriesService["wantedMissing"]>>["candidates"][number];

/**
 * Two related but distinct mechanisms, both against monitored movies/episodes that are
 * missing (roadmap D2, real RSS sync):
 *
 * - `runFeedPoll()` (job `media.rssSync`, frequent — every ~10 min) — the real thing: one
 *   category-only "recent releases" pull per configured indexer, no per-title queries,
 *   reverse-matched against the whole wanted/missing list, deduped against a seen-release
 *   cache so the same rolling-window overlap isn't reprocessed every tick.
 * - `runMissingSearch()` (job `media.missingSearch`, infrequent — daily) — the previous
 *   implementation of this file, unchanged in logic, kept as a safety-net active sweep for
 *   whatever the passive poll hasn't caught (a title added after its release already
 *   scrolled off the RSS window, an indexer that was down when a release appeared).
 *
 * Before this split, both jobs ran under one key (`media.rssSync`) and this file only ever
 * did the active per-title search — "closer to Sonarr's MissingEpisodeSearchService than to
 * RssSyncService," in the gap report's own words. Running a cheap feed poll and an expensive
 * per-title search on the same frequent schedule wouldn't have reduced indexer load at all;
 * splitting them onto different cadences is what actually does, matching upstream's own
 * separation (`FetchAndParseRssService.cs`/`RssSyncService.cs` vs
 * `MissingEpisodeSearchService.cs`).
 *
 * Both entry points share the active-queue/recently-grabbed dedupe and the grab-and-emit
 * pattern, so they stay one service rather than splitting into two.
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
    private readonly decisions: DecisionService,
  ) {}

  // ---------- real RSS sync: passive feed poll ----------

  async runFeedPoll(opts: { limitPerIndexer?: number; maxGrabs?: number } = {}): Promise<{
    polled: number; unseen: number; matched: number; grabbed: number; skipped: number;
  }> {
    await this.pruneSeenReleases();
    const releases = await this.indexers.pollRecent(opts.limitPerIndexer ?? 100);
    const unseen = await this.filterAndMarkSeen(releases);

    // Candidate enumeration MUST go through wantedMissing() — the load-bearing definition
    // of "wanted" (monitored, missing, minimum-availability gate for movies). The decision
    // engine has no monitored/missing check of its own (only upgradeSpecification, a
    // quality comparison), so reverse-matching against anything broader than this would let
    // an unmonitored title match and auto-grab.
    const { candidates: movieCandidates } = await this.movies.wantedMissing(5000);
    const { candidates: wantedEpisodes } = await this.series.wantedMissing(5000);
    const seriesById = new Map<string, { title: string; seriesType: SeriesType; alternateTitles: string[] }>();
    for (const ep of wantedEpisodes) {
      if (!seriesById.has(ep.seriesId)) seriesById.set(ep.seriesId, { title: ep.seriesTitle, seriesType: ep.seriesType as SeriesType, alternateTitles: ep.seriesAlternateTitles ?? [] });
    }

    // Group matches by target: an uncapped poll can return several encodes of the same
    // release across indexers in one tick — grabbing raw feed order would grab whichever
    // appeared first, not the best. pickBest() per group, same as the per-title path does
    // for its own search results.
    const byTarget = new Map<string, { mediaType: "movie" | "series"; mediaId: string; decision: Awaited<ReturnType<DecisionService["evaluate"]>> }[]>();
    for (const release of unseen) {
      const match = this.matchRelease(release, movieCandidates, seriesById, wantedEpisodes);
      if (!match) continue;
      const decision = await this.decisions.evaluate(match.mediaType, match.mediaId, release);
      const key = `${match.mediaType}:${match.mediaId}`;
      const bucket = byTarget.get(key) ?? [];
      bucket.push({ ...match, decision });
      byTarget.set(key, bucket);
    }

    let grabbed = 0;
    let skipped = 0;
    const maxGrabs = opts.maxGrabs ?? 20;
    // Sequential, not Promise.all: hasActiveQueue() must see the effect of a grab earlier
    // in the same tick, same as runMovies()/runSeries() below.
    for (const [, group] of byTarget) {
      if (grabbed >= maxGrabs) { skipped += group.length; continue; }
      const { mediaType, mediaId } = group[0];
      if (await this.hasActiveQueue(mediaType, mediaId)) { skipped += group.length; continue; }
      if (await this.grabbedRecently(mediaType, mediaId)) { skipped += group.length; continue; }
      const best = pickBest(group.map((g) => g.decision));
      if (!best) { skipped += group.length; continue; }
      try {
        await this.indexers.grab({ mediaType, mediaId, releaseId: best.release.id, indexerId: best.release.indexerId, release: best.release });
        grabbed++;
      } catch (err) {
        this.logger.warn(`auto-grab (feed poll) failed for ${mediaType}:${mediaId}: ${(err as Error).message}`);
        this.events.publish(EventTypes.DownloadClientFailed, { mediaId, error: (err as Error).message });
        skipped++;
      }
    }

    const result = { polled: releases.length, unseen: unseen.length, matched: byTarget.size, grabbed, skipped };
    this.logger.log(`rssFeedPoll: polled=${result.polled} unseen=${result.unseen} matched=${result.matched} grabbed=${result.grabbed} skipped=${result.skipped}`);
    return result;
  }

  /** Title/year fuzzy match only — which (mediaType, mediaId) does this release belong to,
   *  if any. Deliberately does NOT resolve a full ReleaseTarget (episode narrowing, season
   *  packs): DecisionService.evaluate() already does that internally via
   *  MediaRepository.resolveTarget(), so doing it again here would just repeat the work.
   *  For an episode-shaped release, the series title must fuzzy-match exactly one wanted
   *  series AND the specific season/episode(s) the release names must actually be among
   *  that series' wanted (missing+monitored) episodes — matching on series title alone
   *  would let a release for an already-complete season match a series that merely has
   *  *some* other wanted episode. Ambiguous matches (0 or 2+ candidates) return null —
   *  skip rather than risk grabbing into the wrong title.
   *
   *  Daily/anime releases name a date or absolute number instead of SxxExx, so they carry
   *  no `season`. They get a parallel path (`matchDailyOrAnime`) that narrows the wanted
   *  episode list by air date / absolute number on the candidate series' own seriesType. */
  private matchRelease(
    release: Release,
    movieCandidates: WantedMovie[],
    seriesById: Map<string, { title: string; seriesType: SeriesType; alternateTitles: string[] }>,
    wantedEpisodes: Awaited<ReturnType<SeriesService["wantedMissing"]>>["candidates"],
  ): { mediaType: "movie" | "series"; mediaId: string } | null {
    const parsed = parseEpisodeRelease(release.title);
    if (parsed.season !== undefined) {
      const hits = [...seriesById.entries()].filter(([, s]) => this.matchesSeriesTitle(parsed.seriesTitle, s));
      if (hits.length !== 1) return null;
      const [seriesId] = hits[0];
      const inSeason = wantedEpisodes.filter((e) => e.seriesId === seriesId && e.seasonNumber === parsed.season);
      if (inSeason.length === 0) return null;
      if (!parsed.isSeasonPack && parsed.episodes.length > 0 && !inSeason.some((e) => parsed.episodes.includes(e.episodeNumber))) return null;
      return { mediaType: "series", mediaId: seriesId };
    }

    const dailyOrAnime = this.matchDailyOrAnime(parsed, seriesById, wantedEpisodes);
    if (dailyOrAnime) return dailyOrAnime;

    const hits = movieCandidates.filter((m) => this.matchesMovie(release, m.title, movieYear(m)));
    return hits.length === 1 ? { mediaType: "movie", mediaId: hits[0].id } : null;
  }

  /** Daily/anime feed-poll narrowing: a release with no season but a date or absolute
   *  number resolves against the wanted episodes of daily/anime candidate series. Same
   *  exactly-one-candidate discipline as the S&E path. Each hit must also fuzzily match a
   *  candidate series title, mirroring the S&E branch's wrong-title guard. */
  private matchDailyOrAnime(
    parsed: ReturnType<typeof parseEpisodeRelease>,
    seriesById: Map<string, { title: string; seriesType: SeriesType; alternateTitles: string[] }>,
    wantedEpisodes: Awaited<ReturnType<SeriesService["wantedMissing"]>>["candidates"],
  ): { mediaType: "series"; mediaId: string } | null {
    if (parsed.dailyDate === undefined && parsed.absoluteNumber === undefined) return null;
    let matchedSeriesId: string | null = null;
    for (const [seriesId, s] of seriesById) {
      if (parsed.seriesTitle && !this.matchesSeriesTitle(parsed.seriesTitle, s)) continue;
      const eps = wantedEpisodes.filter((e) => e.seriesId === seriesId);
      let hit = false;
      if (s.seriesType === "daily" && parsed.dailyDate) {
        hit = eps.some((e) => this.airDateMatches(e.airDateUtc, parsed.dailyDate as string));
      } else if (s.seriesType === "anime" && parsed.absoluteNumber !== undefined) {
        hit = eps.some((e) => e.absoluteNumber === parsed.absoluteNumber);
      }
      if (hit) {
        if (matchedSeriesId) return null; // ambiguous across two series — skip
        matchedSeriesId = seriesId;
      }
    }
    return matchedSeriesId ? { mediaType: "series", mediaId: matchedSeriesId } : null;
  }

  /** Whether an episode's air date falls on `date` (exact, else ±1 day for drift). */
  private airDateMatches(airDateUtc: string | null | undefined, date: string): boolean {
    if (!airDateUtc) return false;
    const day = airDateUtc.slice(0, 10);
    if (day === date) return true;
    const t = new Date(`${day}T00:00:00.000Z`).getTime();
    const base = new Date(`${date}T00:00:00.000Z`).getTime();
    return Number.isNaN(t) || Number.isNaN(base) ? false : Math.abs(t - base) <= 86400000;
  }

  /** Whether a release name (the series-title portion of a parsed title) matches a candidate
   *  series by its primary title OR any alternate title / abbreviation (TVDB aliases, e.g.
   *  "AOT" for Attack on Titan). A match on any one counts; the caller keeps the existing
   *  exact-one-candidate ambiguity discipline on top. */
  private matchesSeriesTitle(releaseHead: string | undefined, s: { title: string; alternateTitles: string[] }): boolean {
    if (!releaseHead) return false;
    if (titleMatches(releaseHead, s.title)) return true;
    return s.alternateTitles.some((a) => !!a && titleMatches(releaseHead, a));
  }

  private async pruneSeenReleases(): Promise<void> {
    const cutoff = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
    await this.db.delete(schema.seenRelease).where(lt(schema.seenRelease.firstSeenAt, cutoff));
  }

  /** Filters a poll's releases to ones not already recorded as seen for their indexer, and
   *  records ALL of them — matched or not — as seen. Separate concern from
   *  hasActiveQueue/grabbedRecently, which guard re-grabbing a *title*; this guards
   *  re-processing the same *feed entry* on the next tick, given a rolling-window feed
   *  returns heavy overlap between consecutive polls. Not transaction-wrapped: this is a
   *  best-effort cache (onConflictDoNothing, idempotent), not a consistency-critical write
   *  — a crash partway through just means a few releases get reprocessed next tick, which
   *  is exactly the kind of thing this cache already has to tolerate. */
  private async filterAndMarkSeen(releases: Release[]): Promise<Release[]> {
    if (releases.length === 0) return [];
    const rows = await this.db.select({ indexerId: schema.seenRelease.indexerId, guid: schema.seenRelease.guid }).from(schema.seenRelease);
    const seen = new Set(rows.map((r) => `${r.indexerId}:${r.guid}`));
    const unseen: Release[] = [];
    const now = new Date().toISOString();
    for (const release of releases) {
      const key = `${release.indexerId}:${release.id}`;
      if (seen.has(key)) continue;
      seen.add(key); // guard duplicate guids within the same poll (e.g. same release under two categories)
      unseen.push(release);
      await this.db.insert(schema.seenRelease).values({
        id: newEntityId("sr"), indexerId: release.indexerId, guid: release.id, firstSeenAt: now,
      }).onConflictDoNothing();
    }
    return unseen;
  }

  // ---------- missing search: active per-title safety-net sweep ----------

  async runMissingSearch(opts: { maxSeries?: number; perSeries?: number; maxMovies?: number } = {}): Promise<{
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
      `missingSearch: movies(scanned=${result.scannedMovies} grabbed=${result.grabbedMovies}) ` +
      `series(scanned=${result.scannedSeries} grabbed=${result.grabbedSeries}) skipped=${result.skipped}`,
    );
    return result;
  }

  private async runMovies(maxMovies: number): Promise<{ scannedMovies: number; grabbed: number; skipped: number }> {
    const { candidates: wanted } = await this.movies.wantedMissing(500);
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
    const year = movieYear(movie);
    const query = year ? `${movie.title} ${year}` : movie.title;
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

  private async runSeries(maxSeries: number, perSeries: number): Promise<{ scannedSeries: number; grabbed: number; skipped: number }> {
    const { candidates: wanted } = await this.series.wantedMissing(500);
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
      const seriesType = firstTarget.seriesType as SeriesType;
      if (await this.grabbedRecently("series", seriesId, (releaseTitle) => this.matchesTarget(seriesType, firstTarget, releaseTitle))) { skipped += eps.length; continue; }

      scannedSeries++;
      const seriesTitle = eps[0].seriesTitle;
      const targets = eps.slice(0, perSeries);
      for (const target of targets) {
        const didGrab = await this.tryGrabEpisode(seriesId, seriesTitle, seriesType, target);
        if (didGrab) { grabbed++; if (await this.hasActiveQueue("series", seriesId)) break; }
        else skipped++;
      }
    }

    return { scannedSeries, grabbed, skipped };
  }

  private async tryGrabEpisode(
    seriesId: string,
    seriesTitle: string,
    seriesType: SeriesType,
    target: WantedEpisode,
  ): Promise<boolean> {
    const query = this.seriesQuery(seriesType, seriesTitle, target);
    const res = await this.indexers.search({ mediaType: "series", mediaId: seriesId, query, limit: 50 });
    if (res.releases.length === 0) return false;

    // Filter to releases whose title actually matches the target episode — SxxExx for
    // standard, air date for daily, absolute number for anime — then let the decision
    // engine's verdicts (already attached to each release by search()) pick the best
    // *approved* candidate, matching the pre-existing S&E behaviour.
    const candidates = res.releases.filter((r) => this.matchesTarget(seriesType, target, r.title));
    const best = pickBest(candidates.map((r) => r.decision));
    if (!best) return false;

    try {
      await this.indexers.grab({ mediaType: "series", mediaId: seriesId, releaseId: best.release.id, indexerId: best.release.indexerId, release: best.release });
      return true;
    } catch (err) {
      this.logger.warn(`auto-grab failed for ${seriesTitle} ${query}: ${(err as Error).message}`);
      this.events.publish(EventTypes.DownloadClientFailed, { seriesId, error: (err as Error).message });
      return false;
    }
  }

  /** The per-title indexer query for a wanted episode, shaped by the series' numbering:
   *  standard → SxxExx tag; daily → the episode's air date; anime → the absolute number.
   *  Formatting follows the parser's own conventions in packages/domain/src/episodes.ts. */
  private seriesQuery(seriesType: SeriesType, seriesTitle: string, target: WantedEpisode): string {
    if (seriesType === "daily" && target.airDateUtc) {
      const date = target.airDateUtc.slice(0, 10).replace(/-/g, ".");
      return `${seriesTitle} ${date}`;
    }
    if (seriesType === "anime" && target.absoluteNumber !== null && target.absoluteNumber !== undefined) {
      return `${seriesTitle} ${target.absoluteNumber}`;
    }
    return `${seriesTitle} ${episodeQueryTag(target.seasonNumber, target.episodeNumber)}`;
  }

  /** Whether a release title matches a wanted episode, by the series' numbering scheme.
   *  Daily/anime prefer their own signal (date / absolute number) and fall back to S&E
   *  when one is present; absent data (null absoluteNumber/airDateUtc) degrades to a no-match. */
  private matchesTarget(seriesType: SeriesType, target: WantedEpisode, title: string): boolean {
    const m = parseEpisodeRelease(title);
    if (seriesType === "daily") {
      if (m.dailyDate && target.airDateUtc && this.airDateMatches(target.airDateUtc, m.dailyDate)) return true;
      return m.season === target.seasonNumber && m.episodes.includes(target.episodeNumber);
    }
    if (seriesType === "anime") {
      if (m.absoluteNumber !== undefined && target.absoluteNumber !== null && m.absoluteNumber === target.absoluteNumber) return true;
      return m.season === target.seasonNumber && m.episodes.includes(target.episodeNumber);
    }
    return m.season === target.seasonNumber && m.episodes.includes(target.episodeNumber);
  }

  // ---------- shared: active-queue / recently-grabbed dedupe ----------

  private async hasActiveQueue(mediaType: "movie" | "series", mediaId: string): Promise<boolean> {
    const rows = await this.db.select({ id: schema.downloadQueueEntry.id }).from(schema.downloadQueueEntry)
      .where(and(
        eq(schema.downloadQueueEntry.mediaType, mediaType),
        eq(schema.downloadQueueEntry.mediaId, mediaId),
        or(...ACTIVE_QUEUE_STATUSES.map((s) => eq(schema.downloadQueueEntry.status, s))),
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

function movieYear(movie: WantedMovie): number | undefined {
  const year = movie.releaseDate ? Number(movie.releaseDate.slice(0, 4)) : undefined;
  return year && !Number.isNaN(year) ? year : undefined;
}
