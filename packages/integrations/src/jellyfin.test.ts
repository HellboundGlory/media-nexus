// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { JellyfinMediaServerProvider, MemoryMediaServerProvider } from "./jellyfin";

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });
async function listen(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, url: URL) => void): Promise<string> {
  const s = createServer((req, res) => handler(req, res, new URL(req.url ?? "/", "http://127.0.0.1")));
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

describe("JellyfinMediaServerProvider", () => {
  it("maps library items by TMDB/TVDB provider ids and lists users", async () => {
    const url = await listen((_req, res, u) => {
      res.writeHead(200, { "content-type": "application/json" });
      if (u.pathname === "/Users") res.end(JSON.stringify([{ Id: "u1", Name: "Alice" }]));
      else if (u.pathname === "/System/Info") res.end(JSON.stringify({ Version: "10.9" }));
      else res.end(JSON.stringify({
        TotalRecordCount: 2,
        Items: [
          { Id: "m1", Type: "Movie", Name: "Dune", ProviderIds: { Tmdb: "438631" } },
          { Id: "s1", Type: "Series", Name: "Severance", ProviderIds: { Tvdb: "405861" } },
        ],
      }));
    });
    const provider = new JellyfinMediaServerProvider({ host: url, apiKey: "jf" });
    expect((await provider.getLibraryItems()).length).toBe(2);
    expect((await provider.getAvailability("movie", "438631")).present).toBe(true);
    expect((await provider.getAvailability("series", "405861")).present).toBe(true);
    expect((await provider.getAvailability("movie", "999")).present).toBe(false);
    const users = await provider.importUsers();
    expect(users[0].username).toBe("Alice");
    expect((await provider.healthcheck()).ok).toBe(true);
  });
});

describe("MemoryMediaServerProvider", () => {
  it("reports preset availability", async () => {
    const provider = new MemoryMediaServerProvider([{ mediaType: "movie", providerId: { tmdb: "1" }, name: "X" }]);
    expect((await provider.getAvailability("movie", "1")).present).toBe(true);
    expect((await provider.getAvailability("series", "1")).present).toBe(false);
    expect((await provider.scanLibrary()).scanned).toBe(1);
  });
});
