// SPDX-License-Identifier: MIT
/**
 * Golden-corpus test (roadmap D4, Stage 1 acceptance criterion).
 *
 * Proves the interpreter against *real* upstream Cardigann v11 definitions (from the
 * Prowlarr/Indexers corpus — copied into fixtures/cardigann) rather than synthetic ones:
 * they must all PARSE cleanly (and be fully supportable — no unimplemented filters), and a
 * representative subset spanning HTML / XML / JSON must actually SEARCH-EXECUTE against
 * mocked responses that satisfy each definition's rows/fields selectors (cross-field
 * `.Result` chaining, `if/else` templates, and filter pipelines included).
 *
 * NOTE: these fixtures are validation corpora for the interpreter, not application code;
 * the D4 licensing decision (use of the upstream defs) is logged separately by the lead.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseCardigannYaml, CardigannProvider } from "./index";

const FIXTURES = join(__dirname, "fixtures", "cardigann");
const defs = readdirSync(FIXTURES).filter((f) => f.endsWith(".yml")).sort();

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

async function listen(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, url: URL) => void): Promise<string> {
  const server = createServer((req, res) => handler(req, res, new URL(req.url ?? "/", "http://127.0.0.1")));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("golden corpus: real upstream defs parse + are fully supportable", () => {
  it(`parses all ${defs.length} sample defs cleanly with no unimplemented filters`, () => {
    expect(defs.length).toBeGreaterThanOrEqual(12);
    const names: string[] = [];
    for (const f of defs) {
      const yaml = readFileSync(join(FIXTURES, f), "utf8");
      const def = parseCardigannYaml(yaml); // must not throw
      expect(def.name, f).toBeTruthy();
      expect(def.unsupportedFilters, f).toEqual([]);
      names.push(f);
    }
    // sanity: sample spans all three response modes
    const text = readFileSync(join(FIXTURES, "yts.yml"), "utf8") + readFileSync(join(FIXTURES, "zamundarip.yml"), "utf8") + readFileSync(join(FIXTURES, "limetorrents.yml"), "utf8");
    expect(text).toContain("type: json");
    expect(text).toContain("type: xml");
  });
});

describe("golden corpus: search-execute real defs against mocked fixtures", () => {
  it("executes a real XML def (zamundarip: rows `rss>channel>item`, attribute fields, dateparse, cross-field sitelink)", async () => {
    const url = await listen((req, res) => {
      expect(String(req.url)).toContain("/api/torznab/api");
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(`<?xml version="1.0"?><rss><channel>
        <item>
          <title>Show.S01E01.1080p.WEB-DL</title>
          <link>https://zamunda.rip/download/1.torrent</link>
          <pubDate>Sun, 08 Feb 2026 19:31:03 +0000</pubDate>
          <attr name="category" value="2040"/>
          <attr name="size" value="2100000000"/>
          <attr name="seeders" value="12"/>
          <attr name="peers" value="3"/>
        </item>
      </channel></rss>`);
    });
    const yaml = readFileSync(join(FIXTURES, "zamundarip.yml"), "utf8");
    const provider = new CardigannProvider({
      key: "golden-zamundarip", protocol: "torrent", definitionText: yaml,
      settings: { baseUrl: url, sitelink: "https://zamunda.rip/" },
    });
    const releases = await provider.search({ mediaType: "series", query: "show" });
    expect(releases).toHaveLength(1);
    expect(releases[0].title).toBe("Show.S01E01.1080p.WEB-DL");
    expect(releases[0].downloadUrl).toBe("https://zamunda.rip/download/1.torrent");
    expect(releases[0].size).toBe(2_100_000_000);
    expect(releases[0].seeders).toBe(12);
    expect(releases[0].categories).toContain(2040);
  });

  it("executes a real HTML def (limetorrents: href→regexp→re_replace title pipeline + cross-field .Result + seeders)", async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<table class="table2"><tbody>
        <tr bgcolor="#fff">
          <td><div class="tt-name"><a href="/show-s01e01-720p-torrent-123.html">Show S01E01 720p</a></div></td>
          <td>Today in TV shows</td>
          <td>1.5 GB</td>
          <td><span class="tdseed">99</span></td>
          <td><span class="tdleech">5</span></td>
        </tr>
      </tbody></table>`);
    });
    const yaml = readFileSync(join(FIXTURES, "limetorrents.yml"), "utf8");
    const provider = new CardigannProvider({
      key: "golden-limetorrents", protocol: "torrent", definitionText: yaml,
      settings: { baseUrl: url, sort: "seeds" },
    });
    const releases = await provider.search({ mediaType: "series", query: "show" });
    expect(releases).toHaveLength(1);
    expect(releases[0].title).toBe("show s01e01 720p");
    expect(releases[0].downloadUrl).toContain("/show-s01e01-720p-torrent-123.html");
    expect(releases[0].seeders).toBe(99);
    expect(releases[0].leechers).toBe(5);
  });

  it("executes a real JSON def (internetarchive: rows `response.docs`, cross-field .Result._id text fields, if/and/else input templates)", async () => {
    const url = await listen((req, res) => {
      expect(String(req.url)).toContain("advancedsearch.php");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        response: { numFound: 1, docs: [{ identifier: "movie_2024", title: "Show.S01E01.1080p.WEB-DL", mediatype: "movies", item_size: "2100000000", btih: "abcdef0123456789abcdef0123456789abcdef01" }] },
      }));
    });
    const yaml = readFileSync(join(FIXTURES, "internetarchive.yml"), "utf8");
    const provider = new CardigannProvider({
      key: "golden-archive", protocol: "torrent", definitionText: yaml,
      settings: { baseUrl: url, titleOnly: true, noMagnet: false, sort: "publicdate", type: "publicdate" },
    });
    const releases = await provider.search({ mediaType: "series", query: "show" });
    expect(releases).toHaveLength(1);
    expect(releases[0].title).toBe("Show.S01E01.1080p.WEB-DL");
    expect(releases[0].downloadUrl).toBe("download/movie_2024/movie_2024_archive.torrent");
    expect(releases[0].infoUrl).toBe("details/movie_2024");
  });
});
