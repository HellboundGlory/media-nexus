// SPDX-License-Identifier: MIT
import { Body, Controller, Delete, Get, Inject, Param, Post, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { and, desc, eq } from "drizzle-orm";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import { z } from "zod";
import { ZodValidationPipe } from "../common/zod.pipe";
import { ActivityService } from "./activity.service";
import { AcquisitionService } from "../acquisition/acquisition.service";
import { parseEpisodeRelease } from "@medianexus/domain";

const historyQuery = z.object({
  mediaType: z.enum(["movie", "series"]).optional(),
  mediaId: z.string().optional(),
  episodeId: z.string().optional(),
  action: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

const queueQuery = z.object({ mediaType: z.enum(["movie", "series"]).optional() });

const bulkRemoveBody = z.object({ ids: z.array(z.string().min(1)).min(1) });
// eslint-disable-next-line no-useless-assignment  -- referenced only inside a NestJS decorator; ESLint 10 doesn't count decorator usage
const manualImportBody = z.object({ path: z.string().min(1).optional() });

@ApiTags("activity")
@Controller("api/v1")
export class ActivityController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly activity: ActivityService,
    private readonly acquisition: AcquisitionService,
  ) {}

  @Get("history")
  @ApiOperation({ summary: "Unified activity history (movies + series)" })
  async history(@Query(new ZodValidationPipe(historyQuery)) q: z.infer<typeof historyQuery>) {
    const conds = [];
    if (q.mediaType) conds.push(eq(schema.historyEntry.mediaType, q.mediaType));
    if (q.mediaId) conds.push(eq(schema.historyEntry.mediaId, q.mediaId));
    if (q.action) conds.push(eq(schema.historyEntry.action, q.action));

    // EPISODEDETAIL-1: optional episodeId narrows a series' history to ONE episode. The series
    // rows are keyed by seriesId (mediaId), and an episode's identity isn't in the history row,
    // so resolve the episode's series/season/episode numbers here, then member-check each row's
    // data client-side per action type (see episodeHistoryMatches below). Any action type we
    // can't confirm membership for is excluded when episodeId filtering is active.
    let episodeFilter: { seriesId: string; seasonNumber: number; episodeNumber: number } | null = null;
    if (q.episodeId) {
      const ep = await this.db
        .select({ seriesId: schema.episode.seriesId, seasonNumber: schema.season.seasonNumber, episodeNumber: schema.episode.episodeNumber })
        .from(schema.episode)
        .innerJoin(schema.season, eq(schema.episode.seasonId, schema.season.id))
        .where(eq(schema.episode.id, q.episodeId))
        .limit(1);
      const found = ep[0];
      if (found) {
        episodeFilter = found;
        // REVIEW (EPISODEDETAIL-1): the episode's seriesId MUST scope the history query to that
        // series. episodeHistoryMatches doesn't check seriesId (a coincidentally same
        // season/episode-numbered row from a different series would otherwise match), and the
        // frontend sends mediaType+mediaId+episodeId together today, so this is normally a no-op
        // — but it closes the gap for episodeId-alone or a mismatched mediaId request.
        conds.push(eq(schema.historyEntry.mediaId, found.seriesId));
      } else return { items: [], total: 0 };
    }

    const rows = await this.db.select().from(schema.historyEntry)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(schema.historyEntry.createdAt)).limit(q.limit);

    const items = episodeFilter
      ? rows.filter((r) => episodeHistoryMatches(r.mediaType, r.action, r.data, episodeFilter))
      : rows;

    return { items, total: items.length };
  }

  @Get("queue")
  @ApiOperation({ summary: "Download queue (unified)" })
  async queue(@Query(new ZodValidationPipe(queueQuery)) q: z.infer<typeof queueQuery>) {
    const conds = [];
    if (q.mediaType) conds.push(eq(schema.downloadQueueEntry.mediaType, q.mediaType));
    const rows = await this.db.select().from(schema.downloadQueueEntry)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(schema.downloadQueueEntry.addedAt));
    return { items: rows, total: rows.length };
  }

  @Delete("queue/:id")
  @ApiOperation({ summary: "Clear a stuck queue entry (does not delete client-side data)" })
  async removeQueueEntry(@Param("id") id: string) {
    return this.activity.removeQueueEntry(id);
  }

  @Post("queue/bulk-remove")
  @ApiOperation({ summary: "Remove multiple queue entries at once" })
  async bulkRemoveQueue(@Body(new ZodValidationPipe(bulkRemoveBody)) body: { ids: string[] }) {
    return this.activity.bulkRemoveQueue(body.ids);
  }

  @Post("history/bulk-remove")
  @ApiOperation({ summary: "Delete multiple history entries at once" })
  async bulkRemoveHistory(@Body(new ZodValidationPipe(bulkRemoveBody)) body: { ids: string[] }) {
    return this.activity.bulkRemoveHistory(body.ids);
  }

  @Post("queue/:id/retry")
  @ApiOperation({ summary: "Re-attempt import of a failed queue entry (re-arms it; never blocklists)" })
  async retryQueueEntry(@Param("id") id: string) {
    return this.acquisition.retryQueueEntry(id);
  }

  @Post("queue/:id/manual-import")
  @ApiOperation({ summary: "Import a queue entry, optionally from an explicit file/folder path" })
  async manualImportQueueEntry(@Param("id") id: string, @Body(new ZodValidationPipe(manualImportBody)) body: { path?: string }) {
    return this.acquisition.manualImportQueueEntry(id, body);
  }
}

/** EPISODEDETAIL-1: whether a history row belongs to a given episode, for the history endpoint's
 *  optional episodeId filter. The series' history rows are keyed by seriesId (mediaId), so
 *  member-check each row's `data` against the resolved episode numbers per action type:
 *  - import_completed: exact — data.season equals the season, and one imported entry's `episodes`
 *    array includes the episode number (the acquisition importer stores epNumberById-mapped ids).
 *  - grabbed / download_failed / removed: best-effort via the SAME parseEpisodeRelease parser the
 *    RSS matcher uses, applied to the release title (data.releaseTitle for grabbed, data.title
 *    for download_failed/removed) — match when season equals AND (episodes includes the number OR
 *    it's a season pack). Daily/anime-numbered releases won't S&E-match here; acceptable gap. */
function episodeHistoryMatches(
  mediaType: string,
  action: string,
  data: Record<string, unknown>,
  ep: { seriesId: string; seasonNumber: number; episodeNumber: number },
): boolean {
  if (mediaType !== "series") return false;

  if (action === "import_completed") {
    const season = data.season;
    if (season !== ep.seasonNumber) return false;
    const imported = (data.imported as { episodes?: unknown[] }[] | undefined) ?? [];
    return imported.some((f) => Array.isArray(f?.episodes) && (f.episodes as unknown[]).includes(ep.episodeNumber));
  }

  if (action === "grabbed" || action === "download_failed" || action === "removed") {
    const title = (data.releaseTitle as string | undefined)
      ?? (data.title as string | undefined);
    if (!title) return false;
    const parsed = parseEpisodeRelease(title);
    if (parsed.season !== ep.seasonNumber) return false;
    return parsed.isSeasonPack || parsed.episodes.includes(ep.episodeNumber);
  }

  // Any other action type: we can't confirm the episode it touched — exclude it.
  return false;
}
