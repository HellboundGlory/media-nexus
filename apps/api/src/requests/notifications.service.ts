// SPDX-License-Identifier: MIT
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { DomainEvent } from "@medianexus/events";
import { EventsService } from "../events/events.service";
import { ConfigService } from "../system/config.service";
import type { WebhookNotificationConfig } from "@medianexus/shared";

/**
 * Notification service (M4): delivers subscribed domain events to configured webhooks.
 * Config lives in `notifications.webhooks` (validated zod) — a real, testable sink;
 * email/push/etc. providers are planned (M5) on the same delivery path.
 */
const WATCHED = new Set([
  "requests.request.created",
  "requests.request.approved",
  "requests.request.declined",
  "requests.request.fulfilled",
  "acquisition.release.grabbed",
  "acquisition.import.completed",
  "discovery.indexer.failed",
  "acquisition.client.failed",
]);

@Injectable()
export class NotificationService implements OnModuleInit {
  private readonly logger = new Logger("Notifications");
  constructor(
    private readonly config: ConfigService,
    private readonly events: EventsService,
  ) {}

  onModuleInit(): void {
    this.events.subscribe("*", (event) => this.onEvent(event), true);
  }

  private async onEvent(event: DomainEvent<any>): Promise<void> {
    // eslint-disable-next-line no-console
    if (event.type === "requests.request.fulfilled") console.error("NOTIFY onEvent saw fulfilled, watched:", WATCHED.has(event.type));
    if (!WATCHED.has(event.type)) return;
    const cfg = await this.config.get();
    const hooks = (cfg["notifications.webhooks"] ?? []) as WebhookNotificationConfig[];
    const matching = hooks.filter((h) => h.url && h.eventTypes.includes(event.type));
    // eslint-disable-next-line no-console
    if (event.type === "requests.request.fulfilled") console.error("NOTIFY matching fulfilled hooks:", matching.length);
    for (const hook of matching) {
      await this.deliver(hook, event).catch((err) => {
        this.logger.warn(`webhook delivery failed (${hook.url}): ${(err as Error).message}`);
      });
    }
  }

  private async deliver(hook: WebhookNotificationConfig, event: DomainEvent<any>): Promise<void> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (hook.secret) headers["x-webhook-secret"] = hook.secret;
    const res = await fetch(hook.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: event.type,
        occurredAt: event.occurredAt,
        correlationId: event.correlationId,
        aggregate: event.aggregate,
        payload: event.payload,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
  }
}
