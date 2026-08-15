// SPDX-License-Identifier: MIT
import { Inject, Injectable, Logger } from "@nestjs/common";
import { eq, desc } from "drizzle-orm";
import { ApiError, newEntityId } from "@medianexus/shared";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import type { DomainEvent } from "@medianexus/events";
import { EventsService } from "../events/events.service";
import { redactSettings, REDACTED } from "../common/redact";
import { deliverToDiscord, deliverToTelegram, deliverToEmail, type NotificationSummary } from "./notify-sinks";
import {
  webhookNotificationSchema,
  discordNotificationSchema,
  telegramNotificationSchema,
  emailNotificationSchema,
} from "@medianexus/shared";
import { z } from "zod";
import {
  decryptNotificationSettings,
  encryptNotificationSettings,
  getProviderSecret,
  NOTIFICATION_SECRET_FIELDS,
} from "../secrets/provider-secrets";

/**
 * Notification service: delivers subscribed domain events to all configured
 * sinks — webhook (JSON POST), Discord webhooks, Telegram Bot API, and Email.
 * Sinks are real `notification` rows (roadmap P2, gap J4/D7), each with a stable
 * id; secret fields are stored encrypted at rest (J9) and decrypted on read.
 */
export interface NotificationSinkResult extends NotificationSummary {
  target?: string;
}
type NotifyKind = "webhook" | "discord" | "telegram" | "email";
const WATCHED = new Set([
  "acquisition.release.grabbed",
  "acquisition.import.completed",
  "acquisition.import.failed",
  "acquisition.download.failed",
  "discovery.indexer.failed",
  "acquisition.client.failed",
]);

/** Per-kind settings validation — the existing shared schemas minus the hoisted `eventTypes` field. */
const NOTIFICATION_SETTINGS_SCHEMA: Record<NotifyKind, z.ZodType> = {
  webhook: webhookNotificationSchema.omit({ eventTypes: true }),
  discord: discordNotificationSchema.omit({ eventTypes: true }),
  telegram: telegramNotificationSchema.omit({ eventTypes: true }),
  email: emailNotificationSchema.omit({ eventTypes: true }),
};

export interface CreateNotificationInput {
  kind: NotifyKind;
  name?: string;
  enabled?: boolean;
  eventTypes?: string[];
  settings?: Record<string, unknown>;
}
export interface UpdateNotificationBody {
  name?: string;
  enabled?: boolean;
  eventTypes?: string[];
  settings?: Record<string, unknown>;
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger("Notifications");
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly events: EventsService,
  ) {}

  onModuleInit(): void {
    this.events.subscribe("*", (event) => this.onEvent(event), true);
  }

  private async onEvent(event: DomainEvent<any>): Promise<void> {
    if (!WATCHED.has(event.type)) return;
    const results = await this.route(event);
    for (const r of results) {
      if (r && !r.ok) this.logger.warn(`${r.kind} delivery failed: ${r.detail ?? r.target ?? "?"}`);
    }
  }

  /** List all configured sinks (secret fields redacted). */
  list() {
    return this.db.select().from(schema.notification).orderBy(desc(schema.notification.createdAt)).then((rows) =>
      rows.map((r) => ({ ...r, settings: redactSettings(r.settings) })),
    );
  }

  async get(id: string) {
    const rows = await this.db.select().from(schema.notification).where(eq(schema.notification.id, id)).limit(1);
    if (!rows[0]) throw ApiError.notFound("notification", id);
    return { ...rows[0], settings: redactSettings(rows[0].settings) };
  }

  async create(input: CreateNotificationInput) {
    const kind = input.kind;
    const schemaCfg = NOTIFICATION_SETTINGS_SCHEMA[kind];
    if (!schemaCfg) throw new ApiError({ code: "VALIDATION_ERROR", message: `Unsupported notification kind "${kind}"` });
    const parsed = schemaCfg.safeParse(input.settings ?? {});
    if (!parsed.success) {
      throw new ApiError({ code: "VALIDATION_ERROR", message: `Invalid settings for ${kind}`, details: parsed.error.issues });
    }
    const now = new Date().toISOString();
    const secret = getProviderSecret();
    const row = {
      id: newEntityId("notif"),
      kind,
      name: input.name ?? kind,
      enabled: input.enabled ?? true,
      eventTypes: input.eventTypes ?? [],
      // J9: store credentials encrypted at rest (decrypted on read when delivering).
      settings: encryptNotificationSettings(kind, parsed.data as Record<string, unknown>, secret) as Record<string, unknown>,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(schema.notification).values(row);
    return { ...row, settings: redactSettings(row.settings) };
  }

  /** Edit a sink (roadmap P2, gap J4/D7). Partial body; `settings` is J9-aware: stored
   *  (encrypted) secrets are decrypted, the client's plaintext merged over them,
   *  re-validated against the kind schema, then re-encrypted — an omitted or `[REDACTED]`
   *  secret is preserved, a new one never lands in plaintext. Returns the redacted row. */
  async update(id: string, input: UpdateNotificationBody) {
    const rows = await this.db.select().from(schema.notification).where(eq(schema.notification.id, id)).limit(1);
    if (!rows[0]) throw ApiError.notFound("notification", id);
    const existing = rows[0];
    const kind = existing.kind as NotifyKind;
    const secret = getProviderSecret();

    let settings = existing.settings;
    if (input.settings) {
      const fields = NOTIFICATION_SECRET_FIELDS[kind] ?? [];
      const decoded = decryptNotificationSettings(kind, existing.settings, secret) as Record<string, unknown>;
      const provided = input.settings as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...decoded, ...provided };
      for (const f of fields) if (provided[f] === REDACTED) merged[f] = decoded[f];
      // email's secret is nested (transport.auth.pass) — handle REDACTED there too.
      if (kind === "email") {
        const pAuth = (provided.transport as { auth?: { pass?: string } } | undefined)?.auth;
        const dAuth = (decoded.transport as { auth?: { pass?: string } } | undefined)?.auth;
        if (pAuth?.pass === REDACTED && dAuth?.pass !== undefined) {
          merged.transport = { ...(merged.transport as object), auth: { ...(merged.transport as { auth?: object }).auth, pass: dAuth.pass } };
        }
      }
      const schemaCfg = NOTIFICATION_SETTINGS_SCHEMA[kind];
      if (!schemaCfg) throw new ApiError({ code: "VALIDATION_ERROR", message: `Unsupported notification kind "${kind}"` });
      const res = schemaCfg.safeParse(merged);
      if (!res.success) {
        throw new ApiError({ code: "VALIDATION_ERROR", message: `Invalid settings for ${kind}`, details: res.error.issues });
      }
      settings = encryptNotificationSettings(kind, res.data as Record<string, unknown>, secret) as Record<string, unknown>;
    }

    const mergedRow = {
      name: input.name ?? existing.name,
      enabled: input.enabled ?? existing.enabled,
      eventTypes: input.eventTypes ?? existing.eventTypes,
      settings,
      updatedAt: new Date().toISOString(),
    };
    await this.db.update(schema.notification).set(mergedRow).where(eq(schema.notification.id, id));
    const updated = { ...existing, ...mergedRow };
    return { ...updated, settings: redactSettings(updated.settings as Record<string, unknown>) };
  }

  async remove(id: string) {
    await this.get(id);
    await this.db.delete(schema.notification).where(eq(schema.notification.id, id));
    return { removed: id };
  }

  /** Fan an event out to every enabled sink whose `eventTypes` matches (data source:
   *  the `notification` table; delivery bodies reused unchanged). */
  async route(event: DomainEvent<any>): Promise<NotificationSinkResult[]> {
    const secret = getProviderSecret();
    const rows = await this.db.select().from(schema.notification).where(eq(schema.notification.enabled, true));
    const out: NotificationSinkResult[] = [];
    for (const row of rows) {
      const subscribed = (row.eventTypes ?? []).includes(event.type);
      if (!subscribed) continue;
      const settings = decryptNotificationSettings(row.kind, row.settings, secret) as Record<string, unknown>;
      try {
        switch (row.kind) {
          case "webhook": {
            const url = settings.url as string;
            if (!url) break;
            const headers: Record<string, string> = { "content-type": "application/json" };
            if (settings.secret) headers["x-webhook-secret"] = settings.secret as string;
            const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(event), signal: AbortSignal.timeout(10_000) });
            out.push({ kind: "webhook", ok: res.ok, detail: res.ok ? undefined : `HTTP ${res.status}`, target: url });
            break;
          }
          case "discord": {
            out.push({ ...(await deliverToDiscord(settings as never, event)), target: (settings.webhookUrl as string) ?? "discord" });
            break;
          }
          case "telegram": {
            out.push({ ...(await deliverToTelegram(settings as never, event, { baseUrl: settings.baseUrl as string | undefined })), target: "telegram" });
            break;
          }
          case "email": {
            const to = Array.isArray(settings.to) ? (settings.to as string[]).join(",") : "";
            out.push({ ...(await deliverToEmail(settings as never, event)), target: to });
            break;
          }
        }
      } catch (err) {
        out.push({ kind: row.kind, ok: false, detail: (err as Error).message, target: row.kind === "email" ? String((settings.to as string[])?.join(",") ?? "") : undefined });
      }
    }
    return out;
  }

  /** Manual test: deliver a canned event to one configured sink (looked up by id). */
  async test(id: string): Promise<NotificationSinkResult> {
    const rows = await this.db.select().from(schema.notification).where(eq(schema.notification.id, id)).limit(1);
    if (!rows[0]) return { kind: "unknown", ok: false, detail: "not found" };
    const row = rows[0];
    const secret = getProviderSecret();
    const settings = decryptNotificationSettings(row.kind, row.settings, secret) as Record<string, unknown>;
    const probe = { type: "system.notification.test", occurredAt: new Date().toISOString(), correlationId: "test", aggregate: {}, payload: { test: true } } as never as DomainEvent<any>;
    const kind = row.kind as NotifyKind;
    try {
      switch (kind) {
        case "discord":
          return { ...(await deliverToDiscord(settings as never, probe)), target: "discord" };
        case "telegram":
          return { ...(await deliverToTelegram(settings as never, probe, { baseUrl: settings.baseUrl as string | undefined })), target: "telegram" };
        case "email": {
          const to = Array.isArray(settings.to) ? (settings.to as string[]).join(",") : "";
          return { ...(await deliverToEmail(settings as never, probe)), target: to };
        }
        default: {
          const url = settings.url as string;
          const headers = { "content-type": "application/json" };
          const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(probe), signal: AbortSignal.timeout(10_000) });
          return { kind, ok: r.ok, detail: r.ok ? undefined : `HTTP ${r.status}`, target: url };
        }
      }
    } catch (err) {
      return { kind, ok: false, detail: (err as Error).message, target: row.kind === "email" ? String((settings.to as string[])?.join(",") ?? "") : undefined };
    }
  }
}
