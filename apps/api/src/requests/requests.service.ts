// SPDX-License-Identifier: MIT
import { Inject, Injectable } from "@nestjs/common";
import { desc, eq, sql } from "drizzle-orm";
import { ApiError, newEntityId } from "@medianexus/shared";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import type { CreateRequest } from "@medianexus/domain";
import { EventsService } from "../events/events.service";
import { EventTypes } from "@medianexus/events";
import type { Principal } from "../common/principal";
import type { MediaType } from "@medianexus/domain";

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
    const autoApprove = principal?.isAdmin ?? false;
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
    const eventAgg = { aggType: input.mediaType, aggId: input.mediaId, requestId: id, userId: principal?.userId ?? undefined };
    this.events.publish(EventTypes.RequestCreated, { requestId: id, mediaType: input.mediaType, mediaId: input.mediaId, autoApproved: autoApprove }, eventAgg);
    if (autoApprove) {
      this.events.publish(EventTypes.RequestApproved, { requestId: id, mediaType: input.mediaType, mediaId: input.mediaId }, eventAgg);
    }
    return this.get(id);
  }

  async list() {
    const rows = await this.db.select().from(schema.request).orderBy(desc(schema.request.requestedAt)).limit(200);
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

  async setStatus(id: string, status: "approved" | "declined") {
    const row = await this.get(id);
    const now = new Date().toISOString();
    await this.db.update(schema.request).set({ status, updatedAt: now }).where(eq(schema.request.id, id));
    const eventAgg = { aggType: row.mediaType as MediaType, aggId: row.mediaId, requestId: id, userId: row.userRequestorId ?? undefined };
    this.events.publish(
      status === "approved" ? EventTypes.RequestApproved : EventTypes.RequestDeclined,
      { requestId: id, mediaType: row.mediaType, mediaId: row.mediaId, status },
      eventAgg,
    );
    return this.get(id);
  }
}
