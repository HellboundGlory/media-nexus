// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buildFetcher } from "./proxy";

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

async function listen(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, url: URL) => void): Promise<string> {
  const server = createServer((req, res) => handler(req, res, new URL(req.url ?? "/", "http://127.0.0.1")));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("buildFetcher", () => {
  it("passes through when no proxy/flaresolverr are configured", async () => {
    const target = await listen((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("plain"); });
    const f = buildFetcher({});
    const res = await f(target);
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe("plain");
  });

  it("routes an http target through an http proxy (absolute-form)", async () => {
    const proxy = await listen((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("proxied:" + req.url);
    });
    const f = buildFetcher({ proxy: { enabled: true, type: "http", host: new URL(proxy).hostname, port: Number(new URL(proxy).port) } });
    const res = await f("http://some-indexer.example/api?t=search");
    expect(res.ok).toBe(true);
    expect((await res.text()).startsWith("proxied:")).toBe(true);
  });

  it("uses FlareSolverr when configured and wraps its solution as a Response", async () => {
    const flare = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", solution: { status: 200, content: "<html>solved</html>", headers: { "content-type": "text/html" } } }));
    });
    const f = buildFetcher({ flareSolverrUrl: flare });
    const res = await f("https://cloudflare-wall.example/api");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("solved");
  });

  it("an unreachable socks proxy rejects", async () => {
    const f = buildFetcher({ proxy: { enabled: true, type: "socks5", host: "127.0.0.1", port: 1 } });
    let rejected = false;
    try { await f("http://example.com"); } catch { rejected = true; }
    expect(rejected).toBe(true);
  });
});
