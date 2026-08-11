// SPDX-License-Identifier: MIT
import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { AUDIT_EVENT_TYPES, type DomainEvent } from "@medianexus/events";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import { EventsService } from "./events.service";

/** Persists audit-worthy domain events to audit_log (observability + security trail). */
@Injectable()
export class AuditListener implements OnModuleInit {
  private readonly logger = new Logger(AuditListener.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly events: EventsService,
  ) {}

  onModuleInit(): void {
    this.events.subscribe("*", (event) => this.persist(event), true);
  }

  private async persist(event: DomainEvent<any>): Promise<void> {
    if (!AUDIT_EVENT_TYPES.has(event.type)) return;
    try {
      await this.db.insert(schema.auditLog).values({
        id: `audit_${event.id.replace(/-/g, "").slice(0, 20)}`,
        correlationId: event.correlationId,
        actor: "system",
        action: event.type,
        entityType: event.aggregate.aggType ?? null,
        entityId: event.aggregate.aggId ?? null,
        details: event.payload as Record<string, unknown>,
        createdAt: event.occurredAt,
      });
    } catch (err) {
      this.logger.error("audit persist failed", err as Error);
    }
  }
}
