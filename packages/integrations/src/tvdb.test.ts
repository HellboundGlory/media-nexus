// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { TvdbProvider, DEFAULT_TVDB_WORKER_URL } from "./tvdb";

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });
async function listen(handler: (u: URL, res: import("node:http").ServerResponse, headers: Record<string, string | string[] | undefined>, body: string) => void): Promise<string> {
  const s = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      handler(new URL(req.url ?? "/", "http://127.0.0.1"), res, req.headers, Buffer.concat(chunks).toString("utf8"));
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

describe("TvdbProvider", () => {
  it("shared-proxy mode: no client login, pages through the official episode list", async () => {
    const seen: string[] = [];
    const url = await listen((u, res) => {
      seen.push(u.pathname);
      res.writeHead(200, { "content-type": "application/json" });
      if (u.searchParams.get("page") === "0") {
        res.end(JSON.stringify({
          data: {
            episodes: [
              { id: 11, seasonNumber: 1, number: 1, absoluteNumber: 1, aired: "2020-01-01" },
              { id: 12, seasonNumber: 1, number: 2, absoluteNumber: 2, aired: "2020-01-08" },
            ],
          },
          links: { next: "/series/7/episodes/official?page=1" },
        }));
      } else {
        res.end(JSON.stringify({ data: { episodes: [{ id: 13, seasonNumber: 2, number: 1, absoluteNumber: 3, aired: "2020-04-01" }] }, links: { next: null } }));
      }
    });
    const p = new TvdbProvider({ baseUrl: url }); // no apiKey -> proxy mode
    const eps = await p.episodes(7, "official");
    expect(eps).toHaveLength(3);
    expect(eps[0]).toEqual({ id: 11, seasonNumber: 1, number: 1, absoluteNumber: 1, aired: "2020-01-01" });
    expect(eps[2]).toMatchObject({ id: 13, seasonNumber: 2, number: 1, absoluteNumber: 3 });
    expect(seen).toContain("/series/7/episodes/official");
  });

  it("defaults baseUrl to the shared proxy URL in proxy mode", () => {
    expect(new TvdbProvider({}).baseUrl).toBe(DEFAULT_TVDB_WORKER_URL);
  });

  it("BYO-key mode: logs in once, reuses the cached bearer token, and injects Authorization", async () => {
    let logins = 0;
    const authHeaders: string[] = [];
    const url = await listen((u, res, headers) => {
      res.writeHead(200, { "content-type": "application/json" });
      if (u.pathname === "/login") {
        logins++;
        res.end(JSON.stringify({ data: { token: "tok-abc" }, status: "success" }));
      } else {
        authHeaders.push(String(headers.authorization ?? ""));
        res.end(JSON.stringify({ data: { episodes: [{ id: 1, seasonNumber: 1, number: 1, absoluteNumber: 1, aired: null }] }, links: { next: null } }));
      }
    });
    const p = new TvdbProvider({ baseUrl: url, apiKey: "secretkey" });
    await p.episodes(5, "official");
    await p.episodes(5, "dvd");
    expect(logins).toBe(1); // token cached across calls
    expect(authHeaders.every((h) => h === "Bearer tok-abc")).toBe(true);
  });

  it("BYO-key mode: re-logins and retries on a 401", async () => {
    let logins = 0;
    let dataCalls = 0;
    const url = await listen((u, res) => {
      if (u.pathname === "/login") {
        logins++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: { token: `tok-${logins}` }, status: "success" }));
        return;
      }
      dataCalls++;
      if (dataCalls === 1) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { episodes: [{ id: 9, seasonNumber: 1, number: 1, absoluteNumber: 1, aired: null }] }, links: { next: null } }));
    });
    const p = new TvdbProvider({ baseUrl: url, apiKey: "secretkey" });
    const eps = await p.episodes(5, "official");
    expect(eps).toHaveLength(1);
    expect(logins).toBe(2); // re-login on 401
  });
});
