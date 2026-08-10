// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseCardigannYaml, cardigannSettingsSchema, substitute, CardigannProvider,
} from "./index";

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

const fixture = readFileSync(join(__dirname, "cardigann-fixture.yml"), "utf8");

async function listen(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, url: URL) => void): Promise<string> {
  const server = createServer((req, res) => handler(req, res, new URL(req.url ?? "/", "http://127.0.0.1")));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("cardigann parsing", () => {
  it("parses a definition (settings + search path)", () => {
    const def = parseCardigannYaml(fixture);
    expect(def.name).toBe("MockPrivateTracker");
    expect(def.settings?.length).toBeGreaterThanOrEqual(2);
    expect(def.search.paths?.[0].path).toBe("/browse.php");
    expect(def.search.paths?.[0].rows).toBe("tr.torrent");
  });

  it("substitutes settings and query in templates", () => {
    expect(substitute("q=${query.plus}", {}, { query: "the 100" })).toBe("q=the 100");
    expect(substitute("apikey=${apikey}", { apikey: "s3cr3t" }, { query: "" })).toBe("apikey=s3cr3t");
  });

  it("generates a validation schema from settings", () => {
    const def = parseCardigannYaml(fixture);
    const schema = cardigannSettingsSchema(def);
    expect(schema.safeParse({ baseUrl: "https://x", apikey: "k" }).success).toBe(true);
    expect(schema.safeParse({ baseUrl: "https://x" }).success).toBe(true); // apikey optional
  });
});

describe("CardigannProvider", () => {
  it("scrapes HTML rows and builds releases", async () => {
    const url = await listen((req, res) => {
      expect(String(req.url)).toContain("/browse.php");
      expect(String(req.url)).toContain("apikey=s3cr3t");
      expect(String(req.url)).toContain("q=");
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<table><tbody>
        <tr class="torrent"><td class="name"><a href="/download/1">Show.S01E01.1080p.WEB-DL</a></td><td class="size">2.1 GB</td><td class="seeders">42</td></tr>
        <tr class="torrent"><td class="name"><a href="/download/2">Show.S01E02.720p.HDTV</a></td><td class="size">700 MB</td><td class="seeders">11</td></tr>
      </tbody></table>`);
    });
    const provider = new CardigannProvider({
      key: "cg-1",
      protocol: "torrent",
      definitionText: fixture,
      settings: { baseUrl: url, apikey: "s3cr3t" },
    });
    const releases = await provider.search({ mediaType: "series", query: "show" });
    expect(releases).toHaveLength(2);
    expect(releases[0].title).toContain("Show.S01E01");
    expect(releases[0].seeders).toBe(42);
    expect(releases[0].size).toBeGreaterThan(2_000_000_000);
    expect(releases[0].quality.resolution).toBe("1080p");
    expect(releases[0].downloadUrl).toContain("/download/1");
  });

  it("supports JSON results via jsonResults", async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ results: [{ title: "Movie.2024.2160p.WEB", link: "https://x/get/1", size: "5000000000" }] }));
    });
    const defText = `name: JsonTrack\nsettings:\n  - name: baseUrl\n    type: text\n    default: ${url}\nsearch:\n  paths:\n    - path: /api\n      inputs:\n        q: "${'${query.plus}'}"\n      jsonResults: results\n      title: title\n      link: link\n      size: size`;
    const provider = new CardigannProvider({ key: "cg-2", protocol: "torrent", definitionText: defText, settings: { baseUrl: url } });
    const releases = await provider.search({ mediaType: "movie", query: "movie" });
    expect(releases).toHaveLength(1);
    expect(releases[0].quality.resolution).toBe("2160p");
    expect(releases[0].size).toBe(5_000_000_000);
  });
});
