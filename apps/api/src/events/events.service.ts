// SPDX-License-Identifier: MIT
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { lt } from "drizzle-orm";
import { EventBus, domainEvent, type EventAggregate, type DomainEvent } from "@medianexus/events";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";

/**
 * Wraps the framework-agnostic EventBus with an explicit publish API for the HTTP layer.
 *
 * Durable event outbox (roadmap P2, gap H6): every published event is ALSO written to the
 * `event_outbox` table before/alongside the in-process bus emit. The live `EventBus` path stays
 * fire-and-forget (SSE, cache invalidation) — the outbox is the durable backstop that survives
 * crashes/restarts and powers SSE `Last-Event-ID` replay (see RealtimeService). An outbox insert
 * failure is logged loudly but never throws out of `publish()` and never suppresses the live path.
 *
 * `db` is injected by Nest in production; it's optional so the many test constructors that build
 * `new EventsService(new EventBus())` (and don't exercise the outbox) keep working unchanged.
 */
@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);
  private readonly pending = new Set<Promise<void>>();
  private publishCount = 0;

  constructor(
    private readonly bus: EventBus,
    @Optional() @Inject(DB_TOKEN) private readonly db?: Db,
  ) {}

  /** Age-based retention (policy choice — matches `pruneSeenReleases`' 14-day default). Bound the
   *  outbox so it doesn't grow forever; SSE replay only needs recent history. Hourly in prod. */
  private scheduledRetentionMs = 60 * 60 * 1000;
  private retentionTimer?: ReturnType<typeof setInterval>;

  onModuleInit(): void {
    if (this.db && !this.retentionTimer) {
      this.retentionTimer = setInterval(() => { void this.pruneOutbox(); }, this.scheduledRetentionMs);
    }
  }

  publish<T>(type: string, payload: T, aggregate: EventAggregate = {}): DomainEvent<T> {
    const event = domainEvent(type, payload, aggregate);
    const work = this.writeOutbox(event);
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
    this.publishCount++;
    if (this.publishCount % 256 === 0) void this.pruneOutbox();
    void this.bus.emit(event);
    return event;
  }

  subscribe(type: string, handler: (event: DomainEvent<any>) => void | Promise<void>, async = true): () => void {
    const off = this.bus.on(type, handler as never, { async });
    return off;
  }

  getBus(): EventBus {
    return this.bus;
  }

  /** Await all in-flight outbox writes (durability + tests). */
  async flushOutbox(): Promise<void> {
    const inflight = [...this.pending];
    if (inflight.length > 0) await Promise.all(inflight);
  }

  /** Remove outbox rows older than `olderThanDays` (default 14). Returns rows deleted. */
  async pruneOutbox(olderThanDays = 14): Promise<number> {
    if (!this.db) return 0;
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 3600 * 1000).toISOString();
    const res = await this.db.delete(schema.eventOutbox).where(lt(schema.eventOutbox.occurredAt, cutoff)).run();
    return res.changes;
  }

  private async writeOutbox(event: DomainEvent<any>): Promise<void> {
    if (!this.db) return;
    try {
      await this.db.insert(schema.eventOutbox).values({
        id: event.id,
        type: event.type,
        version: event.version,
        occurredAt: event.occurredAt,
        correlationId: event.correlationId,
        aggregate: event.aggregate as Record<string, unknown>,
        payload: event.payload,
      }).onConflictDoNothing();
    } catch (err) {
      // Durability is the point: a failed outbox write must never go unnoticed. It also must
      // not crash the publisher's request or suppress the live path.
      this.logger.error(`event outbox persist failed for ${event.type}`, err as Error);
    }
  }
}
