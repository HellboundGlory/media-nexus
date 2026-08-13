// SPDX-License-Identifier: MIT
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { RuntimeSettings, WebhookNotificationConfig, DiscordNotificationConfig, TelegramNotificationConfig, EmailNotificationConfig } from "@medianexus/shared";
import type { DomainEvent } from "@medianexus/events";
import { EventsService } from "../events/events.service";
import { ConfigService } from "../system/config.service";
import { deliverToDiscord, deliverToTelegram, deliverToEmail, type NotificationSummary } from "./notify-sinks";

/**
 * Notification service: delivers subscribed domain events to all configured
 * sinks — webhook (JSON POST), Discord webhooks, Telegram Bot API, and Email.
 * Sinks are added per kind without touching domain logic.
 */
export interface NotificationSinkResult extends NotificationSummary {
  target?: string;
}
export type NotifyKind = "webhook" | "discord" | "telegram" | "email";
export const WATCHED = new Set([
  "acquisition.release.grabbed",
  "acquisition.import.completed",
  "acquisition.import.failed",
  "acquisition.download.failed",
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
    if (!WATCHED.has(event.type)) return;
    const cfg = await this.config.get();
    const results = await this.route(event, cfg);
    for (const r of results) {
      if (r && !r.ok) this.logger.warn(`${r.kind} delivery failed: ${r.detail ?? r.target ?? "?"}`);
    }
  }

  /** Fan an event out to every configured sink that subscribed to its type. */
  async route(event: DomainEvent<any>, cfg?: RuntimeSettings): Promise<NotificationSinkResult[]> {
    const c = cfg ?? (await this.config.get());
    const out: NotificationSinkResult[] = [];

    for (const hook of (c["notifications.webhooks"] ?? []) as WebhookNotificationConfig[]) {
      if (hook.url && (hook.eventTypes ?? []).includes(event.type)) {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (hook.secret) headers["x-webhook-secret"] = hook.secret;
        try {
          const res = await fetch(hook.url, { method: "POST", headers, body: JSON.stringify(event), signal: AbortSignal.timeout(10_000) });
          out.push({ kind: "webhook", ok: res.ok, detail: res.ok ? undefined : `HTTP ${res.status}`, target: hook.url });
        } catch (err) {
          out.push({ kind: "webhook", ok: false, detail: (err as Error).message, target: hook.url });
        }
      }
    }
    for (const d of (c["notifications.discord"] ?? []) as DiscordNotificationConfig[]) {
      if (d.webhookUrl && (d.eventTypes ?? []).includes(event.type)) {
        try { out.push({ ...(await deliverToDiscord(d, event)), target: d.webhookUrl }); }
        catch (err) { out.push({ kind: "discord", ok: false, detail: (err as Error).message, target: d.webhookUrl }); }
      }
    }
    for (const t of (c["notifications.telegram"] ?? []) as TelegramNotificationConfig[]) {
      if (t.botToken && (t.eventTypes ?? []).includes(event.type)) {
        try { out.push({ ...(await deliverToTelegram(t, event, { baseUrl: t.baseUrl })), target: "telegram" }); }
        catch (err) { out.push({ kind: "telegram", ok: false, detail: (err as Error).message, target: "telegram" }); }
      }
    }
    for (const e of (c["notifications.email"] ?? []) as EmailNotificationConfig[]) {
      if (e.to?.length && (e.eventTypes ?? []).includes(event.type)) {
        try { out.push({ ...(await deliverToEmail(e, event)), target: e.to.join(",") }); }
        catch (err) { out.push({ kind: "email", ok: false, detail: (err as Error).message, target: e.to.join(",") }); }
      }
    }
    return out;
  }

  /** Manual test: deliver a canned event to a configured sink. */
  async test(kind: NotifyKind, index: number): Promise<NotificationSinkResult> {
    const c = await this.config.get();
    const probe = { type: "system.notification.test", occurredAt: new Date().toISOString(), correlationId: "test", aggregate: {}, payload: { test: true } } as never as DomainEvent<any>;
    if (kind === "discord") {
      const list = (c["notifications.discord"] ?? []) as DiscordNotificationConfig[];
      if (!list[index]) return { kind, ok: false, detail: "not found" };
      return { ...(await deliverToDiscord(list[index], probe)), target: "discord" };
    }
    if (kind === "telegram") {
      const list = (c["notifications.telegram"] ?? []) as TelegramNotificationConfig[];
      if (!list[index]) return { kind, ok: false, detail: "not found" };
      return { ...(await deliverToTelegram(list[index], probe, { baseUrl: list[index].baseUrl })), target: "telegram" };
    }
    if (kind === "email") {
      const list = (c["notifications.email"] ?? []) as EmailNotificationConfig[];
      if (!list[index]) return { kind, ok: false, detail: "not found" };
      return { ...(await deliverToEmail(list[index], probe)), target: list[index].to.join(",") };
    }
    const list = (c["notifications.webhooks"] ?? []) as WebhookNotificationConfig[];
    if (!list[index]) return { kind, ok: false, detail: "not found" };
    const headers = { "content-type": "application/json" };
    const r = await fetch(list[index].url, { method: "POST", headers, body: JSON.stringify(probe), signal: AbortSignal.timeout(10_000) });
    return { kind, ok: r.ok, detail: r.ok ? undefined : `HTTP ${r.status}`, target: list[index].url };
  }
}
