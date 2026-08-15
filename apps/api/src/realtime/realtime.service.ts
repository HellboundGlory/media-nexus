// SPDX-License-Identifier: MIT
import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { EventBus, type DomainEvent } from "@medianexus/events";
import { asc, eq, gt } from "drizzle-orm";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import { concat, EMPTY, from, interval, map, mergeMap, mergeWith, Subject, type Observable } from "rxjs";
import type { MessageEvent } from "@nestjs/common";
import type { EventAggregate } from "@medianexus/events";

/**
 * Realtime (M5, roadmap P2 gap H6): streams every domain event to SSE clients. The web UI
 * subscribes with a fetch-based reader (X-Api-Key header) and invalidates the affected queries.
 *
 * Durable catch-up: on a reconnect the client sends `Last-Event-ID` (its last seen event's stable
 * uuid). `streamSince()` replays the events that occurred during the gap from the `event_outbox`
 * (exactly those after that id, in order, no duplicates) before switching the client onto the
 * live stream. A plain "replay the last N" is not used — `Last-Event-ID` is honored precisely.
 */
@Injectable()
export class RealtimeService implements OnModuleInit {
  private readonly events$ = new Subject<MessageEvent>();

  constructor(
    private readonly bus: EventBus,
    @Inject(DB_TOKEN) private readonly db: Db,
  ) {}

  onModuleInit(): void {
    this.bus.onAny((event: DomainEvent<any>) => this.publish(event), { async: true });
  }

  private publish(event: DomainEvent<any>): void {
    this.events$.next({ data: JSON.stringify(event), type: event.type, id: event.id });
  }

  /** Live stream only (no replay). */
  stream(): Observable<MessageEvent> {
    return this.streamSince(undefined);
  }

  /** Catch-up (replay from outbox after `lastEventId`) then continue live. */
  streamSince(lastEventId?: string): Observable<MessageEvent> {
    const heartbeat = interval(15_000).pipe(map((): MessageEvent => ({ data: ": ping" })));
    const replay$: Observable<MessageEvent> = lastEventId
      ? from(this.loadAfter(lastEventId)).pipe(mergeMap((events) => events))
      : EMPTY;
    return concat(replay$, this.events$).pipe(mergeWith(heartbeat)) as Observable<MessageEvent>;
  }

  /** Events in the outbox with seq strictly greater than the row for `lastEventId`, in order.
   *  Unknown/evicted lastEventId replays nothing (the client is already past our history). */
  private async loadAfter(lastEventId: string): Promise<MessageEvent[]> {
    const marker = await this.db
      .select({ seq: schema.eventOutbox.seq })
      .from(schema.eventOutbox)
      .where(eq(schema.eventOutbox.id, lastEventId))
      .limit(1);
    if (!marker[0]) return [];
    const rows = await this.db
      .select({
        id: schema.eventOutbox.id, type: schema.eventOutbox.type, version: schema.eventOutbox.version,
        occurredAt: schema.eventOutbox.occurredAt, correlationId: schema.eventOutbox.correlationId,
        aggregate: schema.eventOutbox.aggregate, payload: schema.eventOutbox.payload,
      })
      .from(schema.eventOutbox)
      .where(gt(schema.eventOutbox.seq, marker[0].seq))
      .orderBy(asc(schema.eventOutbox.seq));
    return rows.map((r) => {
      const event: DomainEvent<Record<string, unknown>> = {
        id: r.id, type: r.type, version: r.version, occurredAt: r.occurredAt,
        correlationId: r.correlationId, aggregate: (r.aggregate ?? {}) as unknown as EventAggregate, payload: (r.payload ?? {}) as Record<string, unknown>,
      };
      return { data: JSON.stringify(event), type: r.type, id: r.id };
    });
  }
}
