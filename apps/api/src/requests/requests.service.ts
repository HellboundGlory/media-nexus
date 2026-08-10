// SPDX-License-Identifier: MIT
import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { ApiError, newEntityId } from "@medianexus/shared";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import type { CreateRequest } from "@medianexus/domain";
import { EventsService } from "../events/events.service";
import { EventTypes } from "@medianexus/events";
import type { Principal } from "../common/principal";
import type { MediaType } from "@medianexus/domain";
import { canAutoApprove, canModerateRequests, canSeeAllRequests } from "./policy";

@Injectable()
export class RequestsService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly events: EventsService,
  ) {}

  private async mediaExists(mediaType: MediaType, mediaId: string): Promise<boolean> {
    const table = mediaType === "movie" ? schema.movie : schema.series;
    const rows = await this.db.select().from(table).where(eq(table.id, mediaId)).limit(1);
    return rows.length > 0;
  }

  async create(input: CreateRequest, principal: Principal | undefined) {
    if (!(await this.mediaExists(input.mediaType, input.mediaId))) {
      throw ApiError.notFound(input.mediaType === "movie" ? "movie" : "series", input.mediaId);
    }
    // model availability row if missing
    const existing = await this.db.select().from(schema.mediaAvailability)
      .where(sql`${schema.mediaAvailability.mediaType} = ${input.mediaType} AND ${schema.mediaAvailability.mediaId} = ${input.mediaId}`).limit(1);
    if (!existing.length) {
      await this.db.insert(schema.mediaAvailability).values({ id: newEntityId("av"), mediaType: input.mediaType, mediaId: input.mediaId, status: "unknown" });
    }
    const now = new Date().toISOString();
    const autoApprove = canAutoApprove(principal);
    const id = newEntityId("req");
    await this.db.insert(schema.request).values({
      id,
      userRequestorId: principal?.userId ?? null,
      mediaType: input.mediaType,
      mediaId: input.mediaId,
      status: autoApprove ? "approved" : "pending",
      isAutoApproval: autoApprove,
      requestedAt: now,
      updatedAt: now,
    });
    // per-season granularity for series requests (Seerr parity)
    if (input.mediaType === "series" && input.seasons.length) {
      for (const seasonNumber of input.seasons) {
        await this.db.insert(schema.requestItem).values({
          id: newEntityId("reqit"),
          requestId: id,
          seriesId: input.mediaId,
          seasonNumber,
          episodeNumbers: [],
          status: autoApprove ? "approved" : "pending",
        });
      }
    }
    const eventAgg = { aggType: input.mediaType, aggId: input.mediaId, requestId: id, userId: principal?.userId ?? undefined };
    this.events.publish(EventTypes.RequestCreated, { requestId: id, mediaType: input.mediaType, mediaId: input.mediaId, autoApproved: autoApprove }, eventAgg);
    if (autoApprove) {
      this.events.publish(EventTypes.RequestApproved, { requestId: id, mediaType: input.mediaType, mediaId: input.mediaId }, eventAgg);
    }
    return this.get(id);
  }

  async list(opts: { principal?: Principal } = {}) {
    const all = canSeeAllRequests(opts.principal);
    const rows = all
      ? await this.db.select().from(schema.request).orderBy(desc(schema.request.requestedAt)).limit(200)
      : await this.db.select().from(schema.request).where(opts.principal?.userId ? eq(schema.request.userRequestorId, opts.principal.userId) : undefined).orderBy(desc(schema.request.requestedAt)).limit(200);
    const out = [];
    for (const r of rows) {
      let title: string | null = null;
      if (r.mediaType === "movie") {
        const m = await this.db.select({ t: schema.movie.title }).from(schema.movie).where(eq(schema.movie.id, r.mediaId)).limit(1);
        title = m[0]?.t ?? null;
      } else {
        const s = await this.db.select({ t: schema.series.title }).from(schema.series).where(eq(schema.series.id, r.mediaId)).limit(1);
        title = s[0]?.t ?? null;
      }
      out.push({ ...r, mediaTitle: title });
    }
    return out;
  }

  async get(id: string) {
    const rows = await this.db.select().from(schema.request).where(eq(schema.request.id, id)).limit(1);
    if (!rows[0]) throw ApiError.notFound("request", id);
    return rows[0];
  }

  // ---------- watchlist & content blocklist (Seerr parity, principal-scoped) ----------

  watchlist(userId: string | null) {
    return this.listMediaRefs("watchlist", userId);
  }

  async addWatchlist(userId: string, mediaType: MediaType, mediaId: string) {
    await this.mediaExistsCheck(mediaType, mediaId);
    await this.db.insert(schema.watchlist).values({ id: newEntityId("wl"), userId, mediaType, mediaId, createdAt: new Date().toISOString() }).onConflictDoNothing();
    return { ok: true };
  }

  async removeWatchlist(userId: string, mediaType: string, mediaId: string) {
    await this.db.delete(schema.watchlist).where(and(eq(schema.watchlist.userId, userId), eq(schema.watchlist.mediaType, mediaType), eq(schema.watchlist.mediaId, mediaId)));
    return { removed: true };
  }

  contentBlocklist(userId: string | null) {
    return this.listMediaRefs("block", userId);
  }

  async addContentBlocklist(userId: string, mediaType: MediaType, mediaId: string) {
    await this.mediaExistsCheck(mediaType, mediaId);
    await this.db.insert(schema.userContentBlocklist).values({ id: newEntityId("blk"), userId, mediaType, mediaId, createdAt: new Date().toISOString() }).onConflictDoNothing();
    return { ok: true };
  }

  async removeContentBlocklist(userId: string, mediaType: string, mediaId: string) {
    await this.db.delete(schema.userContentBlocklist).where(and(eq(schema.userContentBlocklist.userId, userId), eq(schema.userContentBlocklist.mediaType, mediaType), eq(schema.userContentBlocklist.mediaId, mediaId)));
    return { removed: true };
  }

  private async listMediaRefs(kind: "watchlist" | "block", userId: string | null) {
    const table = kind === "watchlist" ? schema.watchlist : schema.userContentBlocklist;
    if (!userId) return [];
    const rows = await this.db.select().from(table).where(eq(table.userId, userId)).orderBy(desc(table.createdAt));
    const out = [];
    for (const r of rows) {
      let title: string | null = null;
      if (r.mediaType === "movie") { const m = await this.db.select({ t: schema.movie.title }).from(schema.movie).where(eq(schema.movie.id, r.mediaId)).limit(1); title = m[0]?.t ?? null; }
      else { const s = await this.db.select({ t: schema.series.title }).from(schema.series).where(eq(schema.series.id, r.mediaId)).limit(1); title = s[0]?.t ?? null; }
      out.push({ ...r, title });
    }
    return out;
  }

  private async mediaExistsCheck(mediaType: MediaType, mediaId: string) {
    const t = mediaType === "movie" ? schema.movie : schema.series;
    const rows = await this.db.select().from(t).where(eq(t.id, mediaId)).limit(1);
    if (!rows[0]) throw new ApiError({ code: "NOT_FOUND", message: `${mediaType} ${mediaId} not found` });
  }

  // ---------- request lifecycle (fulfillment) ----------

  /** Called by the import pipeline: mark all requests for this media fulfilled. */
  async markFulfilled(mediaType: MediaType, mediaId: string) {
    const rows = await this.db.select().from(schema.request)
      .where(and(eq(schema.request.mediaType, mediaType), eq(schema.request.mediaId, mediaId)));
    let n = 0;
    const now = new Date().toISOString();
    for (const r of rows) {
      if (r.status === "fulfilled") continue;
      await this.db.update(schema.request).set({ status: "fulfilled", updatedAt: now }).where(eq(schema.request.id, r.id));
      await this.db.update(schema.requestItem).set({ status: "fulfilled" }).where(eq(schema.requestItem.requestId, r.id));
      this.events.publish(
        EventTypes.RequestFulfilled,
        { requestId: r.id, mediaType, mediaId, userId: r.userRequestorId ?? undefined },
        { aggType: mediaType, aggId: mediaId, requestId: r.id, userId: r.userRequestorId ?? undefined },
      );
      n++;
    }
    return { fulfilled: n };
  }

  /** Update a request's processing state (used during auto-search). */
  async setProcessing(id: string, opts: { failed?: boolean } = {}) {
    await this.db.update(schema.request)
      .set({ status: opts.failed ? "failed" : "processing", updatedAt: new Date().toISOString() })
      .where(eq(schema.request.id, id));
  }

  async setStatus(id: string, status: "approved" | "declined", principal?: Principal) {
    if (!canModerateRequests(principal)) {
      throw new ApiError({ code: "FORBIDDEN", message: "Only admins/moderators can approve or decline requests" });
    }
    const row = await this.get(id);
    const now = new Date().toISOString();
    await this.db.update(schema.request).set({ status, updatedAt: now }).where(eq(schema.request.id, id));
    await this.db.update(schema.requestItem).set({ status }).where(eq(schema.requestItem.requestId, id));
    const eventAgg = { aggType: row.mediaType as MediaType, aggId: row.mediaId, requestId: id, userId: row.userRequestorId ?? undefined };
    this.events.publish(
      status === "approved" ? EventTypes.RequestApproved : EventTypes.RequestDeclined,
      { requestId: id, mediaType: row.mediaType, mediaId: row.mediaId, status },
      eventAgg,
    );
    return this.get(id);
  }
}
