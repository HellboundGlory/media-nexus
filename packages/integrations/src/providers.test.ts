// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  NewznabProvider, parseNewznabJson, SabnzbdProvider, QbittorrentProvider,
  TransmissionProvider, NzbgetProvider,
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

  it("captures downloadvolumefactor/uploadvolumefactor and derives isFreeleech (SON-025b)", () => {
    const releases = parseNewznabJson({
      channel: { item: [{
        title: "Dune 2021 1080p WEB", guid: "g1", link: "l1", size: "9000000000",
        "newznab:attr": [
          { name: "size", value: "9000000000" },
          { name: "downloadvolumefactor", value: "0" },
          { name: "uploadvolumefactor", value: "2" },
        ],
      }] },
    }, { indexerId: "i1", indexerName: "idx", protocol: "torrent" });
    const r = releases[0];
    expect(r.isFreeleech).toBe(true); // the pre-existing === "0" derivation preserved
    expect(r.downloadVolumeFactor).toBe(0);
    expect(r.uploadVolumeFactor).toBe(2); // now captured (was not before)
  });

  it("leaves factors undefined + isFreeleech false when a feed provides no volume factors (regression)", () => {
    const releases = parseNewznabJson({ channel: { item: [{ title: "Movie 2020 720p", guid: "g", link: "l", size: "1000" }] } }, { indexerId: "i", indexerName: "n", protocol: "torrent" });
    expect(releases[0].isFreeleech).toBe(false);
    expect(releases[0].downloadVolumeFactor).toBeUndefined();
    expect(releases[0].uploadVolumeFactor).toBeUndefined();
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

describe("TransmissionProvider (HTTP)", () => {
  it("resolves the 409 session-id challenge, adds, reports ratio/seed-time and healthchecks", async () => {
    const methods: string[] = [];
    let challenged = false;
    const { url, server } = await listen((req, res, u) => {
      if (u.pathname !== "/transmission/rpc") { res.writeHead(404); res.end(); return; }
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const sid = req.headers["x-transmission-session-id"];
        if (!challenged) { challenged = true; res.writeHead(409, { "x-transmission-session-id": "SIDXYZ" }); res.end(); return; }
        expect(sid).toBe("SIDXYZ");
        const call = JSON.parse(body);
        methods.push(call.method);
        if (call.method === "torrent-add") json(res, { result: "success", arguments: { "torrent-added": { hashString: "deadbeef" } } });
        else if (call.method === "torrent-get") json(res, { result: "success", arguments: { torrents: [{ hashString: "deadbeef", name: "Matrix.1999.1080p", totalSize: 7000000000, percentDone: 1, status: 6, downloadDir: "/dl", ratio: 2.5, secondsSeeding: 3600 }] } });
        else if (call.method === "session-get") json(res, { result: "success", arguments: { version: "4.0.0" } });
        else json(res, { result: "no such method", arguments: {} });
      });
    });
    servers.push(server);
    const client = new TransmissionProvider({ host: url, category: "movies" });
    const { downloadId } = await client.addRelease({ release: { magnetUrl: "magnet:?xt=urn:btih:deadbeef", title: "Matrix" } as never });
    expect(downloadId).toBe("deadbeef");
    expect(methods).toContain("torrent-add");
    const q = await client.getQueue();
    expect(q[0].status).toBe("completed");
    expect(q[0].ratio).toBe(2.5);
    expect(q[0].seedTimeSeconds).toBe(3600);
    expect(q[0].contentPath).toBe("/dl/Matrix.1999.1080p");
    expect((await client.healthcheck()).ok).toBe(true);
  });

  it("keeps the payload unless deletion is explicitly requested", async () => {
    const bodies: string[] = [];
    let challenged = false;
    const { url, server } = await listen((req, res, u) => {
      if (u.pathname !== "/transmission/rpc") { res.writeHead(404); res.end(); return; }
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        if (!challenged) { challenged = true; res.writeHead(409, { "x-transmission-session-id": "SIDXYZ" }); res.end(); return; }
        bodies.push(body);
        json(res, { result: "success", arguments: {} });
      });
    });
    servers.push(server);
    const client = new TransmissionProvider({ host: url, category: "movies" });
    await client.remove("deadbeef");
    await client.remove("deadbeef", true);
    expect(bodies[0]).toContain('"delete-local-data":false');
    expect(bodies[1]).toContain('"delete-local-data":true');
  });
});

describe("NzbgetProvider (HTTP)", () => {
  it("speaks real NZBGet JSON-RPC: append (11 args), listgroups(0), history(false), version()", async () => {
    const calls: { method: string; params: unknown[] }[] = [];
    const { url, server } = await listen((req, res, u) => {
      if (u.pathname !== "/jsonrpc") { res.writeHead(404); res.end(); return; }
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const call = JSON.parse(body);
        calls.push({ method: call.method, params: call.params });
        if (call.method === "append") json(res, { jsonrpc: "2.0", result: 12345, id: 1 });
        else if (call.method === "listgroups") json(res, { jsonrpc: "2.0", result: [{ NZBID: 12345, NZBName: "Movie.mkv", Status: "DOWNLOADING", FileSizeLo: 1000, RemainingSizeLo: 500 }], id: 1 });
        else if (call.method === "history") json(res, { jsonrpc: "2.0", result: [{ NZBID: 12346, NZBName: "Done.mkv", Status: "SUCCESS" }], id: 1 });
        else if (call.method === "version") json(res, { jsonrpc: "2.0", result: "21.1", id: 1 });
        else json(res, { jsonrpc: "2.0", result: null, id: 1 });
      });
    });
    servers.push(server);
    const client = new NzbgetProvider({ host: url, category: "movies", priority: 0 });
    const { downloadId } = await client.addRelease({ release: { downloadUrl: "https://nzb/file.nzb" } as never });
    expect(downloadId).toBe("12345");
    const statuses = (await client.getQueue()).map((i) => i.status);
    expect(statuses).toContain("downloading");
    expect(statuses).toContain("completed");
    expect((await client.healthcheck()).ok).toBe(true);

    // append(Filename, Content, Category, Priority, AddToTop, AddPaused, DupeKey, DupeScore,
    //       DupeMode, AutoCategory, PPParameters) — 11 positional args, exact shape.
    const appendCall = calls.find((c) => c.method === "append");
    expect(appendCall?.params).toEqual(["", "https://nzb/file.nzb", "movies", 0, false, false, "", 0, "SCORE", false, []]);
    // listgroups(int NumberOfLogEntries) and history(bool Hidden) are mandatory single params.
    expect(calls.find((c) => c.method === "listgroups")?.params).toEqual([0]);
    expect(calls.find((c) => c.method === "history")?.params).toEqual([false]);
    // version() takes no params.
    expect(calls.find((c) => c.method === "version")?.params).toEqual([]);
  });

  it("removes via editqueue(Command, Param, [id]): GroupDelete by default, GroupFinalDelete when deleting files", async () => {
    const calls: { method: string; params: unknown[] }[] = [];
    const { url, server } = await listen((req, res, u) => {
      if (u.pathname !== "/jsonrpc") { res.writeHead(404); res.end(); return; }
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const call = JSON.parse(body);
        calls.push({ method: call.method, params: call.params });
        json(res, { jsonrpc: "2.0", result: true, id: 1 });
      });
    });
    servers.push(server);
    const client = new NzbgetProvider({ host: url, category: "movies", priority: 0 });
    await client.remove("12346");
    await client.remove("12346", true);
    expect(calls.map((c) => c.method)).toEqual(["editqueue", "editqueue"]);
    // editqueue(Command, Param, IDs[]) — Command first, empty Param, one-element int array.
    expect(calls[0].params).toEqual(["GroupDelete", "", [12346]]);
    expect(calls[1].params).toEqual(["GroupFinalDelete", "", [12346]]);
  });

  it("falls back to the History editqueue command when the item is no longer in the active queue", async () => {
    const calls: { method: string; params: unknown[] }[] = [];
    const { url, server } = await listen((req, res, u) => {
      if (u.pathname !== "/jsonrpc") { res.writeHead(404); res.end(); return; }
      let body = ""; req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const call = JSON.parse(body);
        calls.push({ method: call.method, params: call.params });
        // Group commands target the ACTIVE queue and return false once the item has moved to
        // history (the normal usenet case) -> the provider must retry the matching History command.
        const group = String(call.params[0]).startsWith("Group");
        json(res, { jsonrpc: "2.0", result: !group, id: 1 });
      });
    });
    servers.push(server);
    const client = new NzbgetProvider({ host: url, category: "movies", priority: 0 });
    await client.remove("12346");       // soft: queue miss -> HistoryDelete
    await client.remove("12346", true); // hard: queue miss -> HistoryFinalDelete
    expect(calls.length).toBe(4);
    expect(calls[0].params).toEqual(["GroupDelete", "", [12346]]);
    expect(calls[1].params).toEqual(["HistoryDelete", "", [12346]]);
    expect(calls[2].params).toEqual(["GroupFinalDelete", "", [12346]]);
    expect(calls[3].params).toEqual(["HistoryFinalDelete", "", [12346]]);
  });

  it("sends HTTP Basic Authorization when username/password are set", async () => {
    const auths: (string | undefined)[] = [];
    const { url, server } = await listen((req, res, u) => {
      if (u.pathname !== "/jsonrpc") { res.writeHead(404); res.end(); return; }
      auths.push(req.headers.authorization as string | undefined);
      json(res, { jsonrpc: "2.0", result: "26.2", id: 1 });
    });
    servers.push(server);
    // A real user configures host/username/password as separate settings fields, so the provider
    // must send the Basic header itself (Node fetch refuses credentials-in-URL).
    const client = new NzbgetProvider({ host: url, category: "movies", priority: 0, username: "admin", password: "admin" });
    await client.healthcheck();
    expect(auths[0]).toBe("Basic " + Buffer.from("admin:admin").toString("base64"));
  });
});
