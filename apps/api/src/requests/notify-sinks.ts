// SPDX-License-Identifier: MIT
/**
 * Notification sinks (M5): Discord webhooks, Telegram Bot API, and Email (nodemailer).
 * Each returns a human-readable summary for tests/logs. The webhook sink (M4) stays in
 * NotificationService's delivery path alongside these.
 */
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import type { DomainEvent } from "@medianexus/events";
import type { DiscordNotificationConfig, TelegramNotificationConfig, EmailNotificationConfig } from "@medianexus/shared";

export interface NotificationSummary {
  kind: string;
  ok: boolean;
  detail?: string;
}

export function summarize(event: DomainEvent<any>): { title: string; body: string; meta: Record<string, unknown> } {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const title = humanTitle(event.type);
  const body = `[${event.type}] ${JSON.stringify(p)}`;
  return { title, body, meta: { eventType: event.type, correlationId: event.correlationId, aggregate: event.aggregate } };
}

export function humanTitle(type: string): string {
  const map: Record<string, string> = {
    "requests.request.created": "New request",
    "requests.request.approved": "Request approved",
    "requests.request.declined": "Request declined",
    "requests.request.fulfilled": "Request fulfilled",
    "acquisition.release.grabbed": "Release grabbed",
    "acquisition.import.completed": "Import completed",
    "discovery.indexer.failed": "Indexer failed",
    "acquisition.client.failed": "Download client failed",
  };
  return map[type] ?? type.split(".").pop() ?? type;
}

const log = (..._args: unknown[]) => { /* console.debug-level, redacted by logger elsewhere */ };

export async function deliverToDiscord(config: DiscordNotificationConfig, event: DomainEvent<any>): Promise<NotificationSummary> {
  const { title, body, meta } = summarize(event);
  const res = await fetch(config.webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: body,
      embeds: [{ title, description: body.slice(0, 2048), color: 0x8b5cf6, fields: Object.entries(meta).map(([n, v]) => ({ name: n, value: String(v).slice(0, 1000) })) }],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`discord HTTP ${res.status}`);
  return { kind: "discord", ok: true };
}

export async function deliverToTelegram(
  config: TelegramNotificationConfig,
  event: DomainEvent<any>,
  options: { baseUrl?: string } = {},
): Promise<NotificationSummary> {
  const { title, body } = summarize(event);
  const url = `${options.baseUrl ?? "https://api.telegram.org"}/bot${config.botToken}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: config.chatId, text: `*${title}*\n${body.slice(0, 3800)}`, parse_mode: "Markdown" }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`telegram HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { kind: "telegram", ok: true };
}

export async function deliverToEmail(
  config: EmailNotificationConfig,
  event: DomainEvent<any>,
  options: { transporterOverride?: Transporter } = {},
): Promise<NotificationSummary> {
  const { title, body, meta } = summarize(event);
  const transporter = options.transporterOverride ?? (nodemailer.createTransport({
    host: config.transport.host,
    port: config.transport.port,
    secure: config.transport.secure,
    auth: config.transport.auth,
    // dev/test transport: use streamTransport to avoid real SMTP
    streamTransport: options.transporterOverride === undefined && config.transport.host === "test.local",
  } as never) as unknown as Transporter);
  const info = await transporter.sendMail({
    from: config.from,
    to: config.to.join(", "),
    subject: `${config.subject} - ${title}`,
    text: body,
    html: `<p>${body}</p><pre>${JSON.stringify(meta, null, 2)}</pre>`,
  });
  const messageId = (info as { messageId?: string }).messageId;
  log("email delivered", messageId);
  return { kind: "email", ok: true, detail: messageId ?? "sent" };
}

export const NOTIFY_SINK_NAMES = ["webhook", "discord", "telegram", "email"] as const;
