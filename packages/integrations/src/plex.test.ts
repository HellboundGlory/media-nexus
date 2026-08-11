// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PlexMediaServerProvider } from "./plex";

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });
async function listen(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, url: URL) => void): Promise<string> {
  const s = createServer((req, res) => handler(req, res, new URL(req.url ?? "/", "http://127.0.0.1")));
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

describe("PlexMediaServerProvider", () => {
  it("maps library items via sections, supporting both modern Guid[] and legacy guid formats", async () => {
    const url = await listen((_req, res, u) => {
      res.writeHead(200, { "content-type": "application/json" });
      if (u.pathname === "/identity") { res.end(JSON.stringify({ MediaContainer: { machineIdentifier: "abc" } })); return; }
      if (u.pathname === "/library/sections") {
        res.end(JSON.stringify({ MediaContainer: { Directory: [{ key: "1", type: "movie" }, { key: "2", type: "show" }, { key: "3", type: "artist" }] } }));
        return;
      }
      if (u.pathname === "/library/sections/1/all") {
        res.end(JSON.stringify({ MediaContainer: { Metadata: [
          { ratingKey: "m1", title: "Dune", Guid: [{ id: "tmdb://438631" }, { id: "imdb://tt1160419" }] },
        ] } }));
        return;
      }
      if (u.pathname === "/library/sections/2/all") {
        res.end(JSON.stringify({ MediaContainer: { Metadata: [
          { ratingKey: "s1", title: "Severance", guid: "com.plexapp.agents.thetvdb://405861?lang=en" },
        ] } }));
        return;
      }
      res.end(JSON.stringify({}));
    });
    const provider = new PlexMediaServerProvider({ host: url, token: "tok" });
    const items = await provider.getLibraryItems();
    expect(items.length).toBe(2);
    expect((await provider.getAvailability("movie", "438631")).present).toBe(true);
    expect((await provider.getAvailability("series", "405861")).present).toBe(true);
    expect((await provider.getAvailability("movie", "999")).present).toBe(false);
    expect((await provider.scanLibrary()).scanned).toBe(2);
    expect((await provider.healthcheck()).ok).toBe(true);
  });
});
