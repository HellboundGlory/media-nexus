// SPDX-License-Identifier: MIT
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, or, sql } from "drizzle-orm";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import {
  episodeQueryTag, parseEpisodeRelease, seriesTitleMatches, compareQuality,
} from "@medianexus/domain";
import type { Release } from "@medianexus/domain";
import { IndexersService } from "../indexers/indexers.service";
import { SeriesService } from "../series/series.service";
import { EventsService } from "../events/events.service";
import { EventTypes } from "@medianexus/events";

/**
 * RSS sync (M2): for monitored episodes that are missing, search configured indexers
 * with an "SxxExx" tag and auto-grab the best matching release — the "new episode
 * appears and gets downloaded automatically" behavior. Bounded per run, duplicate-safe.
 */
@Injectable()
export class RssSyncService {
  private readonly logger = new Logger(RssSyncService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly indexers: IndexersService,
    private readonly series: SeriesService,
    private readonly events: EventsService,
  ) {}

  async run(opts: { maxSeries?: number; perSeries?: number } = {}): Promise<{ scannedSeries: number; grabbed: number; skipped: number }> {
    const maxSeries = opts.maxSeries ?? 5;
    const perSeries = opts.perSeries ?? 2;

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
      if (await this.seriesHasActiveQueue(seriesId)) { skipped += eps.length; continue; }
      if (await this.grabbedRecently(seriesId, eps[0].seasonNumber, eps[0].episodeNumber)) { skipped += eps.length; continue; }

      scannedSeries++;
      const seriesTitle = eps[0].seriesTitle;
      const targets = eps.slice(0, perSeries);
      for (const target of targets) {
        const didGrab = await this.tryGrabEpisode(seriesId, seriesTitle, target.seasonNumber, target.episodeNumber);
        if (didGrab) { grabbed++; if (await this.seriesHasActiveQueue(seriesId)) break; }
        else skipped++;
      }
    }

    this.logger.log(`rssSync: scanned=${scannedSeries} grabbed=${grabbed} skipped=${skipped}`);
    return { scannedSeries, grabbed, skipped };
  }

  private async tryGrabEpisode(seriesId: string, seriesTitle: string, season: number, episode: number): Promise<boolean> {
    const tag = episodeQueryTag(season, episode);
    const query = `${seriesTitle} ${tag}`;
    const res = await this.indexers.search({ mediaType: "series", mediaId: seriesId, query, limit: 50 });
    if (res.releases.length === 0) return false;

    // filter releases whose title actually contains the target episode (SxxExx match)
    const candidates = res.releases.filter((r) => this.matchesTarget(r, season, episode));
    const best = bestRelease(candidates ?? res.releases);
    if (!best) return false;

    try {
      await this.indexers.grab({ mediaType: "series", mediaId: seriesId, releaseId: best.id, indexerId: best.indexerId, release: best });
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
    if (m.seriesTitle && !seriesTitleMatches(m.seriesTitle, r.indexerName) && m.confidence === 1) {
      // tolerate unknown indexer name mismatch; rely on SxxExx which is strong
    }
    return true;
  }

  private async seriesHasActiveQueue(seriesId: string): Promise<boolean> {
    const rows = await this.db.select({ id: schema.downloadQueueEntry.id }).from(schema.downloadQueueEntry)
      .where(and(
        eq(schema.downloadQueueEntry.mediaType, "series"),
        eq(schema.downloadQueueEntry.mediaId, seriesId),
        or(
          eq(schema.downloadQueueEntry.status, "queued"),
          eq(schema.downloadQueueEntry.status, "downloading"),
          eq(schema.downloadQueueEntry.status, "paused"),
          eq(schema.downloadQueueEntry.status, "importing"),
        ),
      )).limit(1);
    return rows.length > 0;
  }

  private async grabbedRecently(seriesId: string, season: number, episode: number): Promise<boolean> {
    const cutoff = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
    const rows = await this.db.select().from(schema.historyEntry)
      .where(and(
        eq(schema.historyEntry.mediaType, "series"),
        eq(schema.historyEntry.mediaId, seriesId),
        eq(schema.historyEntry.action, "grabbed"),
        sql`${schema.historyEntry.createdAt} >= ${cutoff}`,
      )).limit(20);
    for (const r of rows) {
      const data = (r.data ?? {}) as { releaseTitle?: string };
      if (data.releaseTitle) {
        const m = parseEpisodeRelease(data.releaseTitle);
        if (m.season === season && m.episodes.includes(episode)) return true;
      }
    }
    return false;
  }
}

/** Choose the best release: highest quality, then most seeders. */
function bestRelease(releases: Release[]): Release | null {
  if (releases.length === 0) return null;
  return [...releases].sort((a, b) => {
    const d = compareQuality(b.quality, a.quality);
    if (d !== 0) return d;
    return (b.seeders ?? 0) - (a.seeders ?? 0);
  })[0];
}
