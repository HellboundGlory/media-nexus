// SPDX-License-Identifier: MIT
import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import type { Release } from "@medianexus/domain";
import { parseEpisodeRelease, qualityRank } from "@medianexus/domain";
import { IndexersService } from "../indexers/indexers.service";
import { RequestsService } from "./requests.service";
import { EventsService } from "../events/events.service";
import { EventTypes } from "@medianexus/events";

/**
 * Request fulfillment (M4): on approval, search indexers for the media and grab the
 * best release automatically (Seerr-style). Movies grab their first best release;
 * series grab the first missing monitored episode via an SxxExx search.
 */
@Injectable()
export class RequestFulfillmentService implements OnModuleInit {
  private readonly logger = new Logger(RequestFulfillmentService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly indexers: IndexersService,
    private readonly requests: RequestsService,
    private readonly events: EventsService,
  ) {}

  onModuleInit(): void {
    // The event->job bridge (JobHandlers) triggers media.searchForRequest on approval,
    // which calls fulfillRequest() — the job run is the observable workflow record.
    // A completed import fulfills every open request for that media:
    this.events.subscribe(EventTypes.ImportCompleted, (event) => {
      const p = event.payload as { mediaType?: string; mediaId?: string };
      const mediaType = (p.mediaType ?? event.aggregate.aggType) as "movie" | "series" | undefined;
      if (mediaType !== "movie" && mediaType !== "series") return;
      const mediaId = p.mediaId ?? (event.aggregate.aggId as string | undefined);
      if (!mediaId) return;
      void this.requests.markFulfilled(mediaType, mediaId).catch((e) => this.logger.warn(`markFulfilled failed: ${(e as Error).message}`));
    });
  }

  async fulfillRequest(requestId: string): Promise<{ grabbed: boolean; message: string }> {
    const rows = await this.db.select().from(schema.request).where(eq(schema.request.id, requestId)).limit(1);
    const req = rows[0];
    if (!req) return { grabbed: false, message: "request not found" };

    await this.requests.setProcessing(requestId);
    const grabbed = req.mediaType === "movie"
      ? await this.grabMovie(req.mediaId)
      : await this.grabSeriesEpisode(req.mediaId);
    if (!grabbed) {
      await this.requests.setProcessing(requestId, { failed: true });
      return { grabbed: false, message: "no suitable release found" };
    }
    return { grabbed: true, message: "grabbed" };
  }

  private async grabMovie(mediaId: string): Promise<boolean> {
    const rows = await this.db.select().from(schema.movie).where(eq(schema.movie.id, mediaId)).limit(1);
    if (!rows[0]) return false;
    const res = await this.indexers.search({ mediaType: "movie", mediaId, query: rows[0].title, limit: 30 });
    const best = bestRelease(res.releases);
    if (!best) return false;
    try {
      await this.indexers.grab({ mediaType: "movie", mediaId, releaseId: best.id, indexerId: best.indexerId, release: best });
      return true;
    } catch (err) {
      this.logger.warn(`auto-grab movie failed: ${(err as Error).message}`);
      return false;
    }
  }

  private async grabSeriesEpisode(seriesId: string): Promise<boolean> {
    const series = await this.db.select().from(schema.series).where(eq(schema.series.id, seriesId)).limit(1);
    if (!series[0]) return false;
    const target = await this.db
      .select({ episode: schema.episode })
      .from(schema.episode)
      .where(and(eq(schema.episode.seriesId, seriesId), eq(schema.episode.monitored, true), eq(schema.episode.hasFile, false)))
      .orderBy(asc(schema.episode.episodeNumber))
      .limit(1);
    const ep = target[0]?.episode;
    if (!ep) return false; // no monitorable episodes defined yet

    const seasonRows = await this.db.select().from(schema.season).where(eq(schema.season.id, ep.seasonId)).limit(1);
    const seasonNumber = seasonRows[0]?.seasonNumber ?? 1;

    const res = await this.indexers.search({
      mediaType: "series", mediaId: seriesId,
      query: series[0].title, seasons: [seasonNumber], episodes: [ep.episodeNumber], limit: 30,
    });
    const best = bestRelease(res.releases.filter((r) => releaseMatches(r, seasonNumber, ep.episodeNumber)));
    if (!best) return false;
    try {
      await this.indexers.grab({ mediaType: "series", mediaId: seriesId, releaseId: best.id, indexerId: best.indexerId, release: best });
      return true;
    } catch (err) {
      this.logger.warn(`auto-grab series episode failed: ${(err as Error).message}`);
      return false;
    }
  }
}

export function bestRelease(releases: Release[]): Release | null {
  if (!releases.length) return null;
  return [...releases].sort((a, b) => {
    const d = qualityRank(b.quality) - qualityRank(a.quality);
    return d !== 0 ? d : (b.seeders ?? 0) - (a.seeders ?? 0);
  })[0];
}

/** A release is a match when its parsed episode set includes the target. */
export function releaseMatches(r: Release, season: number, episode: number): boolean {
  const m = parseEpisodeRelease(r.title);
  return m.season === season && m.episodes.includes(episode);
}
