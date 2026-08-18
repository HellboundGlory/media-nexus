// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseCardigannYaml, cardigannSettingsSchema, substitute, CardigannProvider, UnsupportedFilterError,
} from "./index";
import { applyFilter, isFilterSupported, parseCardigannDate } from "./cardigann-filters";
import { renderTemplate } from "./cardigann-template";

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

const fixture = readFileSync(join(__dirname, "cardigann-fixture.yml"), "utf8");

async function listen(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, url: URL) => void): Promise<string> {
  const server = createServer((req, res) => handler(req, res, new URL(req.url ?? "/", "http://127.0.0.1")));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

// ---------------------------------------------------------------------------
// Parsing (new v11 rows/fields model) + old-shape migration guard
// ---------------------------------------------------------------------------

describe("cardigann parsing (v11 model)", () => {
  it("parses rows/fields blocks and Go-template inputs", () => {
    const def = parseCardigannYaml(fixture);
    expect(def.name).toBe("MockPrivateTracker");
    expect(def.settings?.length).toBeGreaterThanOrEqual(2);
    expect(def.search.rows?.selector).toBe("tr.torrent");
    expect(def.search.fields?.title?.selector).toBe("td.name a");
    expect(def.search.fields?.details?.attribute).toBe("href");
    expect(def.search.paths?.[0].path).toBe("/browse.php");
    expect(def.unsupportedFilters).toEqual([]);
  });

  it("rejects the old flat-shape model (rows + field selectors on one path) with a clear error", () => {
    const oldShape = `name: OldShape\nsettings:\n  - name: baseUrl\n    type: text\nsearch:\n  paths:\n    - path: /browse\n      rows: tr.row\n      title: td.name a\n      link: td.name a@href\n      size: td.size\n`;
    expect(() => parseCardigannYaml(oldShape)).toThrow(/old flat-shape model/);
  });

  it("keeps the legacy ${...} substitute working (back-compat)", () => {
    expect(substitute("q=${query.plus}", {}, { query: "the 100" })).toBe("q=the 100");
    expect(substitute("apikey=${apikey}", { apikey: "demo-key" }, { query: "" })).toBe("apikey=demo-key");
  });

  it("generates a validation schema from settings", () => {
    const def = parseCardigannYaml(fixture);
    const schema = cardigannSettingsSchema(def);
    expect(schema.safeParse({ baseUrl: "https://x", apikey: "k" }).success).toBe(true);
    expect(schema.safeParse({ baseUrl: "https://x" }).success).toBe(true); // apikey optional
  });

  it("flags (not silently accepts) a def using an unimplemented filter", () => {
    const unsupported = `name: BadFilter\nsettings:\n  - name: baseUrl\n    type: text\nsearch:\n  paths:\n    - path: /x\n  rows:\n    selector: tr\n  fields:\n    title:\n      selector: a\n      filters:\n        - name: hexdump\n`;
    const def = parseCardigannYaml(unsupported);
    expect(def.unsupportedFilters).toContain("hexdump");
  });
});

// ---------------------------------------------------------------------------
// Template engine
// ---------------------------------------------------------------------------

describe("cardigann Go-template engine", () => {
  const funcs = {}; // builtins (eq/or/and/join) only
  it("substitutes bare + dotted vars and if/else", () => {
    const ctx = { Config: { flag: true, url: "https://x" }, Keywords: "matrix", True: true, False: false };
    expect(renderTemplate("q={{ .Keywords }}", ctx, funcs)).toBe("q=matrix");
    expect(renderTemplate("{{ if .Config.flag }}Y{{ else }}N{{ end }}", ctx, funcs)).toBe("Y");
    expect(renderTemplate("{{ if .Config.nope }}Y{{ else }}N{{ end }}", ctx, funcs)).toBe("N");
  });
  it("supports range over .Categories with a loop variable and eq/or/and", () => {
    const ctx = { Config: { sort: false }, Keywords: "x", Categories: [10, 27], True: true, False: false };
    expect(renderTemplate("{{ range .Categories }}c{{.}}=1&{{end}}", ctx, funcs)).toBe("c10=1&c27=1&");
    expect(renderTemplate("{{ if and (.Keywords) (eq .Config.sort .False) }}ok{{ else }}bad{{ end }}", ctx, funcs)).toBe("ok");
    expect(renderTemplate("{{ if or .Result.a .Result.b }}hit{{ else }}miss{{ end }}", ctx, funcs)).toBe("miss");
  });
  it("rejects unknown template functions rather than guessing", () => {
    expect(() => renderTemplate("{{ printf .Keywords }}", { Keywords: "x" }, funcs)).toThrow(/unsupported/);
  });
});

// ---------------------------------------------------------------------------
// Filter pipeline
// ---------------------------------------------------------------------------

describe("cardigann filter pipeline", () => {
  it("implements the high-frequency string filters", () => {
    expect(applyFilter("append", "abc", ["XX"])).toBe("abcXX");
    expect(applyFilter("prepend", "abc", ["YY"])).toBe("YYabc");
    expect(applyFilter("replace", "a-b-c", ["-", "."])).toBe("a.b.c");
    expect(applyFilter("tolower", "AbC")).toBe("abc");
    expect(applyFilter("toupper", "AbC")).toBe("ABC");
    expect(applyFilter("trim", "  hi  ")).toBe("hi");
    expect(applyFilter("split", "a|b|c", ["|", 1])).toBe("b");
    expect(applyFilter("querystring", "browse.php?cat=16", ["cat"])).toBe("16");
    expect(applyFilter("urldecode", "a%20b+c")).toBe("a b c");
    expect(applyFilter("htmldecode", "a&amp;b")).toBe("a&b");
  });
  it("implements re_replace (Go regex including (?i) and \\p{Is<Script>}) and regexp capture", () => {
    expect(applyFilter("re_replace", "WEB dl", ["(?i)\\bdl\\b", "DL"])).toBe("WEB DL");
    expect(applyFilter("re_replace", "SEZON", [String.raw`\p{IsCyrillic}`, "x"])).toBe("SEZON");
    const m = applyFilter("regexp", "magnet:?xt=urn:btih:ABCDEF0123456789abcdef0123456789abcdef01", ["([A-Fa-f0-9]{40})"]);
    expect(m).toBe("ABCDEF0123456789abcdef0123456789abcdef01");
  });
  it("parses Cardigann date layouts to epoch ms (dateparse)", () => {
    const ts = applyFilter("dateparse", "2024-06-02 19:24:18 +0200", "yyyy-MM-dd HH:mm:ss zzz");
    expect(typeof ts).toBe("number");
    expect(new Date(ts as number).toISOString()).toBe("2024-06-02T17:24:18.000Z");
    const ddd = parseCardigannDate("Tue, 02 Jun 2026 19:24:18 +0000", "ddd, dd MMM yyyy HH:mm:ss zzz")!;
    expect(new Date(ddd).toISOString()).toBe("2026-06-02T19:24:18.000Z");
    expect(typeof applyFilter("timeago", "2 hours ago")).toBe("number");
  });
  it("reports unsupported filters (never silently mis-executes)", () => {
    expect(isFilterSupported("replace")).toBe(true);
    expect(isFilterSupported("strdump")).toBe(false);
    expect(isFilterSupported("reltime")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Provider: HTML / JSON / XML + field-ordering + sessionState
// ---------------------------------------------------------------------------

describe("CardigannProvider", () => {
  it("scrapes HTML rows (v11 rows/fields blocks) and builds releases", async () => {
    const url = await listen((req, res) => {
      expect(String(req.url)).toContain("/browse.php");
      expect(String(req.url)).toContain("apikey=demo-key");
      expect(String(req.url)).toContain("q=");
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<table><tbody>
        <tr class="torrent"><td class="name"><a href="/download/1">Show.S01E01.1080p.WEB-DL</a></td><td class="size">2.1 GB</td><td class="seeders">42</td></tr>
        <tr class="torrent"><td class="name"><a href="/download/2">Show.S01E02.720p.HDTV</a></td><td class="size">700 MB</td><td class="seeders">11</td></tr>
      </tbody></table>`);
    });
    const provider = new CardigannProvider({
      key: "cg-1", protocol: "torrent", definitionText: fixture, settings: { baseUrl: url, apikey: "demo-key" },
    });
    const releases = await provider.search({ mediaType: "series", query: "show" });
    expect(releases).toHaveLength(2);
    expect(releases[0].title).toContain("Show.S01E01");
    expect(releases[0].seeders).toBe(42);
    expect(releases[0].size).toBeGreaterThan(2_000_000_000);
    expect(releases[0].quality.resolution).toBe("1080p");
    expect(releases[0].categories).toContain(1000);
    expect(releases[0].downloadUrl).toContain("/download/1");
  });

  it("supports JSON responses via rows/fields JSON paths", async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ results: [{ title: "Movie.2024.2160p.WEB", link: "https://x/get/1", size: "5000000000", seeders: "5" }] }));
    });
    const defText = `name: JsonTrack\nsettings:\n  - name: baseUrl\n    type: text\n    default: ${url}\nsearch:\n  paths:\n    - path: /api\n      response:\n        type: json\n      inputs:\n        q: "{{ .Keywords }}"\n  rows:\n    selector: results\n  fields:\n    title:\n      selector: title\n    download:\n      selector: link\n    details:\n      selector: link\n    size:\n      selector: size\n    seeders:\n      selector: seeders`;
    const provider = new CardigannProvider({ key: "cg-2", protocol: "torrent", definitionText: defText, settings: { baseUrl: url } });
    const releases = await provider.search({ mediaType: "movie", query: "movie" });
    expect(releases).toHaveLength(1);
    expect(releases[0].quality.resolution).toBe("2160p");
    expect(releases[0].size).toBe(5_000_000_000);
    expect(releases[0].downloadUrl).toBe("https://x/get/1");
  });

  it("parses XML responses (cheerio xmlMode + attribute extraction)", async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(`<?xml version="1.0"?><rss><channel>
        <item><title>Show.S01E01.1080p.WEB-DL</title><enclosure url="https://x/t/1"/><size>2100000000</size><seeders>12</seeders><category>2040</category></item>
      </channel></rss>`);
    });
    const defText = `name: XmlTrack\nsettings:\n  - name: baseUrl\n    type: text\n    default: ${url}\nsearch:\n  paths:\n    - path: /api\n      response:\n        type: xml\n      inputs:\n        q: "{{ .Keywords }}"\n  rows:\n    selector: rss > channel > item\n  fields:\n    title:\n      selector: title\n    download:\n      selector: enclosure\n      attribute: url\n    size:\n      selector: size\n    seeders:\n      selector: seeders\n    category:\n      selector: category`;
    const provider = new CardigannProvider({ key: "cg-3", protocol: "torrent", definitionText: defText, settings: { baseUrl: url } });
    const releases = await provider.search({ mediaType: "series", query: "show" });
    expect(releases).toHaveLength(1);
    expect(releases[0].downloadUrl).toBe("https://x/t/1");
    expect(releases[0].size).toBe(2_100_000_000);
    expect(releases[0].categories).toContain(2040);
  });

  it("rejects search on a def using an unimplemented filter (flagged, not mis-executed)", async () => {
    const url = await listen((_req, res) => { res.writeHead(200); res.end("<tr><td>x</td></tr>"); });
    const defText = `name: Bad\nsettings:\n  - name: baseUrl\n    type: text\nsearch:\n  paths:\n    - path: /x\n  rows:\n    selector: tr\n  fields:\n    title:\n      selector: td\n      filters:\n        - name: strdump\n`;
    const provider = new CardigannProvider({ key: "cg-4", protocol: "torrent", definitionText: defText, settings: { baseUrl: url } });
    await expect(provider.search({ mediaType: "movie", query: "x" })).rejects.toThrow(UnsupportedFilterError);
  });

  it("round-trips sessionState through configure -> search -> accessor even when empty", async () => {
    const url = await listen((_req, res) => { res.writeHead(200); res.end("<table><tr class='torrent'><td class='name'><a href='/d/1'>M.2024.1080p</a></td><td class='size'>1 GB</td><td class='seeders'>3</td></tr></table>"); });
    const provider = new CardigannProvider({
      key: "cg-5", protocol: "torrent", definitionText: fixture, settings: { baseUrl: url, apikey: "demo-key" },
      sessionState: "enc:ciphertext:iv",
    });
    expect(provider.sessionState).toBe("enc:ciphertext:iv");
    const releases = await provider.search({ mediaType: "movie", query: "m" });
    expect(releases.length).toBeGreaterThan(0);
    // value survives the call unchanged (no-op until Stage 2 login writes to it)
    expect(provider.sessionState).toBe("enc:ciphertext:iv");
  });

  it("evaluates fields in declaration order with cross-field .Result chaining + conditional text (1337x-style)", async () => {
    const url = await listen((req, res) => {
      expect(String(req.url)).toContain("/search");
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<table><tbody>
        <tr><td class="coll-1"><a href="/torrent/123/Game-2023-2160p-WEB/">Game 2023 2160p WEB ...</a></td><td class="coll-2">9</td><td class="coll-4">4.2 GB</td></tr>
      </tbody></table>`);
    });
    const defText = `name: Mock1337x\nsettings:\n  - name: baseUrl\n    type: text\n    default: ${url}\nsearch:\n  paths:\n    - path: /search\n      inputs:\n        q: "{{ .Keywords }}"\n  rows:\n    selector: "tr:has(a[href^='/torrent/'])"\n  fields:\n    title_default:\n      selector: "td[class^='coll-1'] a[href^='/torrent/']"\n    title_optional:\n      optional: true\n      selector: "td[class^='coll-1'] a:contains('...')"\n      attribute: href\n      filters:\n        - name: split\n          args: ["/", 3]\n    title:\n      text: "{{ if .Result.title_optional }}{{ .Result.title_optional }}{{ else }}{{ .Result.title_default }}{{ end }}"\n    category:\n      text: "40"\n    details:\n      selector: "td[class^='coll-1'] a[href^='/torrent/']"\n      attribute: href\n    download:\n      selector: "td[class^='coll-1'] a[href^='/torrent/']"\n      attribute: href\n    seeders:\n      selector: "td[class^='coll-2']"\n    size:\n      selector: "td[class^='coll-4']"\n`;
    const provider = new CardigannProvider({ key: "l1337", protocol: "torrent", definitionText: defText, settings: { baseUrl: url } });
    const releases = await provider.search({ mediaType: "movie", query: "game" });
    expect(releases).toHaveLength(1);
    // title_optional (href `/torrent/Game-...` split → 'Game-2023-2160p-WEB') wins over title_default
    expect(releases[0].title).toBe("Game-2023-2160p-WEB");
    expect(releases[0].downloadUrl).toContain("/torrent/123/Game-2023-2160p-WEB");
    expect(releases[0].categories).toContain(40);
    expect(releases[0].seeders).toBe(9);
  });

  it("derives isFreeleech + raw volume factors from downloadvolumefactor/uploadvolumefactor (SON-025b)", async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ results: [{ title: "Show.S01E01.1080p.WEB", link: "https://x/get/1", size: "5000000000", seeders: "5", downloadvolumefactor: "0", uploadvolumefactor: "2" }] }));
    });
    const defText = `name: VolFactorTrack\nsettings:\n  - name: baseUrl\n    type: text\n    default: ${url}\nsearch:\n  paths:\n    - path: /api\n      response:\n        type: json\n  rows:\n    selector: results\n  fields:\n    title:\n      selector: title\n    download:\n      selector: link\n    size:\n      selector: size\n    seeders:\n      selector: seeders\n    downloadvolumefactor:\n      selector: downloadvolumefactor\n    uploadvolumefactor:\n      selector: uploadvolumefactor`;
    const provider = new CardigannProvider({ key: "cg-vf", protocol: "torrent", definitionText: defText, settings: { baseUrl: url } });
    const releases = await provider.search({ mediaType: "series", query: "show" });
    expect(releases).toHaveLength(1);
    // The actual bug fixed: this was hardcoded `isFreeleech: false` before SON-025b.
    expect(releases[0].isFreeleech).toBe(true);
    expect(releases[0].downloadVolumeFactor).toBe(0);
    expect(releases[0].uploadVolumeFactor).toBe(2);
  });

  it("regression: a definition with no volume-factor fields is completely unchanged (isFreeleech false, no raw factors)", async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ results: [{ title: "Show.S01E02.720p.HDTV", link: "https://x/get/2", size: "1000000000", seeders: "3" }] }));
    });
    const defText = `name: PlainTrack\nsettings:\n  - name: baseUrl\n    type: text\n    default: ${url}\nsearch:\n  paths:\n    - path: /api\n      response:\n        type: json\n  rows:\n    selector: results\n  fields:\n    title:\n      selector: title\n    download:\n      selector: link\n    size:\n      selector: size\n    seeders:\n      selector: seeders`;
    const provider = new CardigannProvider({ key: "cg-plain", protocol: "torrent", definitionText: defText, settings: { baseUrl: url } });
    const releases = await provider.search({ mediaType: "series", query: "show" });
    expect(releases).toHaveLength(1);
    expect(releases[0].isFreeleech).toBe(false);
    expect(releases[0].downloadVolumeFactor).toBeUndefined();
    expect(releases[0].uploadVolumeFactor).toBeUndefined();
  });

  it("regression: a case-only freeleech selector with no matching case yields '' -> NOT freeleech (SON-025b)", async () => {
    // A DOM row with NO span.fl element: the downloadvolumefactor case-only selector matches no
    // case and has no "*" fallback, so the field evaluates to "" (not "0"). That empty string
    // must read as "no data" (isFreeleech false), NOT be coerced to 0 (isFreeleech true).
    const url = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<table><tbody>
        <tr class="item"><td class="name"><a href="/d/1">Movie.2020.1080p.WEB</a></td><td class="size">1.5 GB</td><td class="seeders">10</td></tr>
      </tbody></table>`);
    });
    const defText = `name: CaseOnlyVF\nsettings:\n  - name: baseUrl\n    type: text\n    default: ${url}\nsearch:\n  paths:\n    - path: /api\n  rows:\n    selector: tr.item\n  fields:\n    title:\n      selector: td.name a\n    download:\n      selector: td.name a\n      attribute: href\n    size:\n      selector: td.size\n    seeders:\n      selector: td.seeders\n    downloadvolumefactor:\n      case:\n        "span.fl": "0"`;
    const provider = new CardigannProvider({ key: "cg-casevf", protocol: "torrent", definitionText: defText, settings: { baseUrl: url } });
    const releases = await provider.search({ mediaType: "movie", query: "movie" });
    expect(releases).toHaveLength(1);
    expect(releases[0].isFreeleech).toBe(false);
    expect(releases[0].downloadVolumeFactor).toBeUndefined();
    expect(releases[0].uploadVolumeFactor).toBeUndefined();
  });
});
