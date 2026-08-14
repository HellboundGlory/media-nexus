// SPDX-License-Identifier: MIT
/**
 * Roadmap P1, gap report D1 — Newznab/Torznab indexer protocol gaps.
 *
 * Covers the three in-scope sub-gaps:
 *  - `pubDate` -> `ageHours` parsing in parseNewznabJson (was hardcoded 0)
 *  - ID-based search: the provider emits `t=tvsearch` (series + tvdbid + season/ep) and
 *    `t=movie` (movie + imdbid/tmdbid) instead of fuzzy `t=search`, while query-only and
 *    empty-query (RSS) searches still resolve to `t=search` unchanged
 *  - capability detection: `capabilities()` parses a `t=caps&o=json` response, and a fresh
 *    DB carries the new per-indexer `capabilities` column (migration 0014)
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, schema } from "@medianexus/database";
import { eq } from "drizzle-orm";
import { parseNewznabJson, NewznabProvider, parseNewznabCaps } from "@medianexus/integrations";
import type { NewznabJson } from "@medianexus/integrations";

const dir = mkdtempSync(join(tmpdir(), "mn-d1-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });

/** Stub fetch that records the requested URL and returns canned JSON. */
function stubFetch(calls: string[], body: unknown = { channel: {} }): typeof fetch {
  return (async (url: unknown) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => body };
  }) as unknown as typeof fetch;
}
function provider(calls: string[], body: unknown = { channel: {} }): NewznabProvider {
  return new NewznabProvider("i1", "usenet", { baseUrl: "https://nz.example", apiKey: "k", categories: [2000, 5000] } as never, stubFetch(calls, body));
}

const OPTS = { indexerId: "i1", indexerName: "nz.example", protocol: "usenet" as const };

describe("D1 pubDate -> ageHours", () => {
  it("parses an RFC 2822 pubDate into hours since now", () => {
    const dt = new Date(Date.now() - 3 * 3_600_000);
    const json: NewznabJson = { channel: { item: [{ title: "X.2024.1080p", guid: "g1", pubDate: dt.toUTCString() }] } };
    const rel = parseNewznabJson(json, OPTS)[0];
    expect(rel.ageHours).toBeGreaterThanOrEqual(2);
    expect(rel.ageHours).toBeLessThanOrEqual(4);
  });

  it("falls back to 0 on a missing/unparseable pubDate", () => {
    const json: NewznabJson = { channel: { item: [{ title: "X.2024.1080p", guid: "g1" }] } };
    expect(parseNewznabJson(json, OPTS)[0].ageHours).toBe(0);
    const bad: NewznabJson = { channel: { item: [{ title: "Y", guid: "g2", pubDate: "not-a-date" }] } };
    expect(parseNewznabJson(bad, OPTS)[0].ageHours).toBe(0);
  });
});

describe("D1 ID-based search modes", () => {
  it("emits t=movie + imdbid for a movie with an IMDB id", async () => {
    const calls: string[] = [];
    await provider(calls).search({ mediaType: "movie", imdbId: "tt1234567", query: "Some Movie" });
    const q = calls[0];
    expect(q).toContain("t=movie");
    expect(q).toContain("imdbid=tt1234567");
    expect(q).toContain("o=json");
    expect(q).toContain("apikey=k");
  });

  it("emits t=tvsearch + tvdbid/season/ep for a series targeting an episode", async () => {
    const calls: string[] = [];
    await provider(calls).search({ mediaType: "series", tvdbId: 321, season: 2, episode: 5, query: "Some Show" });
    const q = calls[0];
    expect(q).toContain("t=tvsearch");
    expect(q).toContain("tvdbid=321");
    expect(q).toContain("season=2");
    expect(q).toContain("ep=5");
  });

  it("falls back to t=search for a query-only search and an empty-query RSS poll", async () => {
    const calls: string[] = [];
    await provider(calls).search({ mediaType: "movie", query: "Just A Title" });
    const a = calls[0];
    expect(a).toContain("t=search");
    expect(a).toContain("q=Just+A+Title");
    expect(a).toContain("cat=2000%2C5000");
    // empty query -> category/RSS poll, same as pollRecent()
    calls.length = 0;
    await provider(calls).search({ mediaType: "movie" });
    expect(calls[0]).toContain("t=search");
    expect(calls[0]).toContain("cat=2000%2C5000");
    expect(calls[0]).not.toContain("q=");
  });

  it("falls back to t=search for a series with no tvdbId", async () => {
    const calls: string[] = [];
    await provider(calls).search({ mediaType: "series", query: "No Id Show" });
    expect(calls[0]).toContain("t=search");
  });
});

describe("D1 capability detection + persistence column", () => {
  it("parses a t=caps response into normalized searchModes + categories", async () => {
    const capsBody: NewznabJson = {
      channel: {
        caps: {
          searching: {
            search: { available: "yes", supportedParams: "q,cat" },
            "tv-search": { available: "yes", supportedParams: "q,tvdbid,season,ep" },
            "movie-search": { available: "no", supportedParams: "" },
          },
          categories: { category: [{ id: 5000 }, { id: 5030 }] },
        },
      },
    };
    const parsed = parseNewznabCaps(capsBody);
    const modes = parsed.searchModes as Record<string, { available: boolean; supportedParams: string[] }>;
    expect(modes.search.available).toBe(true);
    expect(modes.tvsearch.available).toBe(true);
    expect(modes.tvsearch.supportedParams).toContain("tvdbid");
    expect(modes.movie.available).toBe(false);
    expect(parsed.categories).toEqual([5000, 5030]);
  });

  it("provider.capabilities() sends t=caps & returns the parsed map", async () => {
    const calls: string[] = [];
    const body = { channel: { caps: { searching: { search: { available: "yes", supportedParams: "q,cat" } } } } };
    const p = provider(calls, body);
    const caps = await p.capabilities();
    expect(calls[0]).toContain("t=caps");
    expect((caps.searchModes as Record<string, { available: boolean }>).search.available).toBe(true);
  });

  it("fresh DB applies migration 0014 (indexer.capabilities column)", async () => {
    const handle = createDb(join(dir, "d1-mig.db"));
    handle.runMigrations();
    handles.push(handle);
    const db = handle.db;
    const now = new Date().toISOString();
    const caps = { searchModes: { search: { available: true, supportedParams: [] } } };
    db.insert(schema.indexer).values({
      id: "i1", definitionKey: "generic-newznab", name: "n", protocol: "usenet", enabled: true,
      implementation: "newznab", settings: {}, priority: 25, status: "disabled", capabilities: caps,
      tags: [], createdAt: now, updatedAt: now,
    }).run();
    const row = db.select().from(schema.indexer).where(eq(schema.indexer.id, "i1")).all()[0] as any;
    expect(row.capabilities.searchModes.search.available).toBe(true);
    handle.close();
  });
});
