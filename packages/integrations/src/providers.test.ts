// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  NewznabProvider, parseNewznabJson, SabnzbdProvider, QbittorrentProvider,
} from "./index";

function listen(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, url: URL) => void): Promise<{ url: string; server: Server; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    seen.push(u.pathname + u.search);
    handler(req, res, u);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, server, seen });
    });
  });
}

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

function json(res: import("node:http").ServerResponse, data: unknown, extra?: Record<string, string>) {
  res.writeHead(200, { "content-type": "application/json", ...extra });
  res.end(JSON.stringify(data));
}

describe("newznab parser", () => {
  it("parses usenet items with attrs", () => {
    const releases = parseNewznabJson({
      channel: {
        item: [{
          title: "The Matrix 1999 1080p BluRay x264-GROUP",
          guid: "https://nzbx/details/1",
          link: "https://nzbx/getnzb/1",
          size: "4200000000",
          category: ["2000", "5000"],
          "newznab:attr": [
            { name: "size", value: "4200000000" },
            { name: "category", value: "2000,5000" },
            { name: "seeders", value: "120" },
            { name: "magneturl", value: "magnet:?xt=urn:btih:abc" },
          ],
        }],
      },
    }, { indexerId: "i1", indexerName: "idx", protocol: "torrent" });

    expect(releases).toHaveLength(1);
    const r = releases[0];
    expect(r.title).toContain("Matrix");
    expect(r.size).toBe(4_200_000_000);
    expect(r.categories).toContain(2000);
    expect(r.seeders).toBe(120);
    expect(r.magnetUrl).toBe("magnet:?xt=urn:btih:abc");
    expect(r.quality.resolution).toBe("1080p");
    expect(r.quality.source).toBe("bluray");
  });

  it("is tolerant of missing fields", () => {
    const releases = parseNewznabJson({ channel: { item: [{ guid: "g" }] } }, { indexerId: "i", indexerName: "n", protocol: "usenet" });
    expect(releases[0].size).toBe(0);
    expect(releases[0].categories).toEqual([]);
  });
});

describe("NewznabProvider (HTTP)", () => {
  it("searches a live mock indexer via the documented API shape", async () => {
    const { url, server, seen } = await listen((_req, res, u) => {
      if (u.searchParams.get("t") === "caps") json(res, { channel: { title: "caps" } });
      else json(res, { channel: { item: [{ title: "Dune 2021 2160p WEB", guid: "g1", link: "l1", "newznab:attr": [{ name: "size", value: "9000000000" }] }] } });
    });
    servers.push(server);
    const provider = new NewznabProvider("i1", "torrent", { baseUrl: url, apiKey: "sekrit", categories: [2000, 5000] });
    const releases = await provider.search({ mediaType: "movie", query: "dune" });
    expect(releases).toHaveLength(1);
    expect(releases[0].title).toContain("Dune");
    expect(releases[0].indexerId).toBe("i1");
    expect(seen.some((s) => s.includes("t=search") && s.includes("q=dune") && s.includes("apikey=sekrit") && s.includes("o=json"))).toBe(true);
    expect((await provider.healthcheck()).ok).toBe(true);
  });

  it("returns ok=false when the indexer is unreachable", async () => {
    const provider = new NewznabProvider("i", "usenet", { baseUrl: "http://127.0.0.1:1", apiKey: "x" });
    expect((await provider.healthcheck()).ok).toBe(false);
  });
});

describe("SabnzbdProvider (HTTP)", () => {
  it("adds, reports queue + completed history and removes", async () => {
    const { url, server } = await listen((_req, res, u) => {
      const mode = u.searchParams.get("mode");
      if (mode === "addurl") json(res, { status: true, nzo_ids: ["NZO1"] });
      else if (mode === "queue") json(res, { queue: { slots: [{ nzo_id: "NZO1", filename: "Movie.mkv", status: "Downloading", mb: "4000", mb_left: "2000", percentage: "50" }] } });
      else if (mode === "history") json(res, { history: { slots: [{ nzo_id: "NZO1", filename: "Movie.mkv", status: "Completed" }] } });
      else json(res, { status: false, error: "unknown mode" });
    });
    servers.push(server);
    const client = new SabnzbdProvider({ host: url, apiKey: "k", category: "movies" });
    const { downloadId } = await client.addRelease({ release: { downloadUrl: "https://nzb/file.nzb" } as never, category: "movies" });
    expect(downloadId).toBe("NZO1");
    const queue = await client.getQueue();
    expect(queue.map((q) => q.status)).toEqual(expect.arrayContaining(["downloading", "completed"]));
    const completed = queue.find((q) => q.status === "completed")!;
    expect(completed.downloadId).toBe("NZO1");
    await client.remove("NZO1"); // no throw
    expect((await client.healthcheck()).ok).toBe(true);
  });
});

describe("QbittorrentProvider (HTTP)", () => {
  it("logs in, adds by magnet, tracks a completed torrent", async () => {
    const { url, server } = await listen((_req, res, u) => {
      if (u.pathname === "/api/v2/app/version") { res.writeHead(200); res.end("v4.6.0"); return; }
      if (u.pathname === "/api/v2/auth/login") { res.writeHead(200, { "set-cookie": ["SID=abc123"] }); res.end("Ok."); return; }
      if (u.pathname === "/api/v2/torrents/add") { res.writeHead(200); res.end("Ok."); return; }
      if (u.pathname === "/api/v2/torrents/info") {
        json(res, [{ hash: "deadbeef", name: "Blade.Runner.2049.1080p.WEB", size: 7000000000, progress: 1, state: "uploading", content_path: "/downloads/Blade-Runner-2049" }]);
        return;
      }
      res.writeHead(404); res.end();
    });
    servers.push(server);
    const client = new QbittorrentProvider({ host: url, username: "admin", password: "pw", category: "movies", tag: "mn" });
    const { downloadId } = await client.addRelease({ release: { magnetUrl: "magnet:?xt=urn:btih:dEaDbEeF", title: "Blade.Runner.2049.1080p.WEB" } as never });
    expect(downloadId).toBe("deadbeef");
    const queue = await client.getQueue();
    expect(queue[0].status).toBe("completed");
    expect(queue[0].contentPath).toBe("/downloads/Blade-Runner-2049");
    expect((await client.healthcheck()).ok).toBe(true);
  });

  // Regression: remove() hardcoded deleteFiles=true, so importing a torrent deleted its
  // payload and killed the seed.
  it("keeps the payload unless deletion is explicitly requested", async () => {
    const bodies: string[] = [];
    const { url, server } = await listen((req, res, u) => {
      if (u.pathname === "/api/v2/torrents/delete") {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => { bodies.push(body); res.writeHead(200); res.end("Ok."); });
        return;
      }
      res.writeHead(200); res.end("Ok.");
    });
    servers.push(server);
    const client = new QbittorrentProvider({ host: url, category: "movies", tag: "mn" } as never);

    await client.remove("deadbeef");
    expect(bodies[0]).toContain("deleteFiles=false");

    await client.remove("deadbeef", true);
    expect(bodies[1]).toContain("deleteFiles=true");
  });
});

describe("SabnzbdProvider removal", () => {
  // Regression: remove() only cleared the queue, so a finished job stayed visible in
  // history and the monitor re-imported it on every poll.
  it("clears both the queue and the history slot", async () => {
    const { url, server, seen } = await listen((_req, res) => { json(res, { status: true }); });
    servers.push(server);
    const client = new SabnzbdProvider({ host: url, apiKey: "k", category: "movies" } as never);

    await client.remove("NZO1");

    const modes = seen.map((s) => new URLSearchParams(s.split("?")[1]).get("mode"));
    expect(modes).toContain("queue");
    expect(modes).toContain("history");
    const historyCall = seen.find((s) => s.includes("mode=history"))!;
    expect(historyCall).toContain("name=delete");
    expect(historyCall).toContain("del_files=0");
  });
});
