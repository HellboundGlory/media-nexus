// SPDX-License-Identifier: MIT
import { Injectable } from "@nestjs/common";
import { EventBus, domainEvent, type EventAggregate, type DomainEvent } from "@medianexus/events";


/** Wraps the framework-agnostic EventBus with an explicit publish API for the HTTP layer. */
@Injectable()
export class EventsService {
  constructor(private readonly bus: EventBus) {}

  publish<T>(type: string, payload: T, aggregate: EventAggregate = {}): DomainEvent<T> {
    const event = domainEvent(type, payload, aggregate);
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
}
