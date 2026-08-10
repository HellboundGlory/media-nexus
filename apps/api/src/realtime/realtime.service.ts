// SPDX-License-Identifier: MIT
import { Injectable, OnModuleInit } from "@nestjs/common";
import { EventBus, type DomainEvent } from "@medianexus/events";
import { Subject, interval, map, merge } from "rxjs";
import type { Observable } from "rxjs";
import type { MessageEvent } from "@nestjs/common";

/**
 * Realtime (M5): streams every domain event to SSE clients. The web UI subscribes
 * with a fetch-based reader (X-Api-Key header) and invalidates the affected queries.
 */
@Injectable()
export class RealtimeService implements OnModuleInit {
  private readonly events$ = new Subject<MessageEvent>();

  constructor(private readonly bus: EventBus) {}

  onModuleInit(): void {
    this.bus.onAny((event: DomainEvent<any>) => this.publish(event), { async: true });
  }

  private publish(event: DomainEvent<any>): void {
    this.events$.next({ data: JSON.stringify(event), type: event.type, id: event.id });
  }

  stream(): Observable<MessageEvent> {
    const heartbeat = interval(15_000).pipe(map((): MessageEvent => ({ data: ": ping" })));
    return merge(this.events$, heartbeat) as Observable<MessageEvent>;
  }
}
