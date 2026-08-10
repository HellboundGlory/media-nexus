// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import nodemailer from "nodemailer";
import { domainEvent, EventTypes } from "@medianexus/events";
import { deliverToDiscord, deliverToTelegram, deliverToEmail } from "../src/requests/notify-sinks";
import { RateLimitGuard } from "../src/requests/rate-limit.guard";
import { MetricsService } from "../src/observability/metrics.service";

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });
async function listen(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, body: string) => void): Promise<string> {
  const s = createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => handler(req, res, b));
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

const ev = domainEvent(EventTypes.ReleaseGrabbed, { title: "Test 1080p", mediaId: "m1" }, { aggId: "m1" });

describe("notification sinks", () => {
  it("delivers to a Discord webhook", async () => {
    const seen: string[] = [];
    const url = await listen((_req, res, body) => { seen.push(body); res.writeHead(204); res.end(); });
    const r = await deliverToDiscord({ webhookUrl: url, eventTypes: [] }, ev);
    expect(r.ok).toBe(true);
    const payload = JSON.parse(seen[0]);
    expect(payload.embeds[0].title).toBe("Release grabbed");
    expect(payload.embeds[0].color).toBe(0x8b5cf6);
  });

  it("delivers to Telegram and reports non-2xx as failure", async () => {
    const url = await listen((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true })); });
    const ok = await deliverToTelegram({ botToken: "TOK", chatId: "123", eventTypes: [] }, ev, { baseUrl: url });
    expect(ok.ok).toBe(true);
    const url403 = await listen((_req, res) => { res.writeHead(403, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false })); });
    await expect(deliverToTelegram({ botToken: "B", chatId: "1", eventTypes: [] }, ev, { baseUrl: url403 })).rejects.toThrow();
  });

  it("emails via a stream transport override (no real SMTP)", async () => {
    const transport = nodemailer.createTransport({ streamTransport: true, newline: "unix" });
    const r = await deliverToEmail(
      { from: "me@test.local", to: ["you@test.local"], transport: { host: "test.local", port: 587, secure: false }, eventTypes: [] },
      ev,
      { transporterOverride: transport },
    );
    expect(r.ok).toBe(true);
    expect(r.detail).toBeTruthy();
  });
});

describe("RateLimitGuard", () => {
  it("allows under the limit and rejects over it", async () => {
    const guard = new RateLimitGuard().configure(60_000, 2);
    const makeCtx = () => ({
      switchToHttp: () => ({
        getRequest: () => ({ headers: {}, socket: { remoteAddress: "10.0.0.1" }, route: { path: "/api/v1/requests" }, originalUrl: "/api/v1/requests" }),
      }),
    }) as never;
    expect(await guard.canActivate(makeCtx())).toBe(true);
    expect(await guard.canActivate(makeCtx())).toBe(true);
    await expect(guard.canActivate(makeCtx())).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});

describe("MetricsService", () => {
  it("renders Prometheus text with recorded counters", () => {
    const m = new MetricsService();
    m.recordRequest("/api/v1/movies", "GET", 200, 5);
    m.recordJobRun("succeeded");
    const text = m.render();
    expect(text).toContain('http_requests_total{method="GET",route="/api/v1/movies"} 1');
    expect(text).toContain('job_runs_total{status="succeeded"} 1');
    expect(text).toMatch(/uptime_seconds \d+/);
  });
});
