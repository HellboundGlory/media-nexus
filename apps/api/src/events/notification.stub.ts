// SPDX-License-Identifier: MIT
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { type DomainEvent } from "@medianexus/events";
import { EventsService } from "./events.service";

/**
 * Placeholder for the notification subsystem (M5): logs the first interesting event
 * types that real providers will eventually deliver (webhook/email/Discord/...).
 */
@Injectable()
export class NotificationStub implements OnModuleInit {
  private readonly logger = new Logger("Notifications");
  private readonly watched = new Set([
    "acquisition.release.grabbed",
    "acquisition.import.completed",
    "requests.request.created",
    "requests.request.approved",
  ]);

  constructor(private readonly events: EventsService) {}

  onModuleInit(): void {
    this.events.subscribe("*", (event) => this.notify(event), true);
  }

  private notify(event: DomainEvent<any>): void {
    if (!this.watched.has(event.type)) return;
    this.logger.log({ eventType: event.type, aggregate: event.aggregate, meta: event.payload });
  }
}
