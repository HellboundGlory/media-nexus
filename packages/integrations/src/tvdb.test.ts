// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { TvdbProvider, tmdbIdFromRemoteIds, DEFAULT_TVDB_WORKER_URL } from "./tvdb";

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

  it("returns deduped series aliases from /series/{id}/extended", async () => {
    let path = "";
    const url = await listen((u, res) => {
      path = u.pathname;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { aliases: [{ language: "en", name: "AOT" }, { language: "de", name: "SNK" }, { language: "ja", name: "aot" }] } }));
    });
    const p = new TvdbProvider({ baseUrl: url });
    expect(await p.seriesAliases(267440)).toEqual(["AOT", "SNK"]); // deduped case-insensitively
    expect(path).toBe("/series/267440/extended");
  });

  // ---- series primary-source surface (TVDB migration) — shapes mirror live API responses ----

  it("search maps type=series results and post-filters the fuzzy index down to name/alias hits", async () => {
    let requested = "";
    const url = await listen((u, res) => {
      requested = `${u.pathname}${u.search}`;
      res.writeHead(200, { "content-type": "application/json" });
      // Mirrors a real response: exact-name hit first, an alias-only hit, then fuzz noise.
      res.end(JSON.stringify({
        data: [
          {
            tvdb_id: "253138", id: "series-253138", name: "Top Boy", year: "2011",
            first_air_time: "2011-10-31", overview: "east London drama", status: "Ended",
            image_url: "https://artworks.thetvdb.com/banners/series/253138/posters/x.jpg",
            aliases: ["Top Boy: Summerhouse"],
            remote_ids: [{ id: "41889", type: 12, sourceName: "TheMovieDB.com" }, { id: "tt1830379", sourceName: "IMDB" }],
          },
          { tvdb_id: "999", name: "Some Other Show", aliases: ["Top Boy: Summerhouse"], year: "2015", status: "Ended" },
          { tvdb_id: "888", name: "Toy Boy", year: "2019", status: "Ended" },
        ],
      }));
    });
    const p = new TvdbProvider({ baseUrl: url });
    const results = await p.search("Top Boy");
    expect(requested).toBe("/search?query=Top%20Boy&type=series");
    expect(results.map((r) => r.externalId)).toEqual(["253138", "999"]); // alias hit kept, fuzz dropped
    const [hit] = results;
    expect(hit.title).toBe("Top Boy");
    expect(hit.year).toBe(2011);
    expect(hit.releaseDate).toBe("2011-10-31");
    expect(hit.status).toBe("Ended");
    expect(hit.images).toEqual([{ coverType: "poster", url: "https://artworks.thetvdb.com/banners/series/253138/posters/x.jpg" }]);
    expect(hit.rating).toBeUndefined(); // no rating field on TVDB search results
  });

  it("getDetails maps the extended record (status.name, US content rating, runtime) and extracts tmdbId", async () => {
    let path = "";
    const url = await listen((u, res) => {
      path = u.pathname;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        data: {
          id: 253138, name: "Top Boy", overview: "east London drama",
          image: "https://artworks.thetvdb.com/banners/series/253138/posters/x.jpg",
          firstAired: "2011-10-31", year: "2011",
          status: { id: 2, name: "Ended", recordType: "series", keepUpdated: false },
          genres: [{ id: 12, name: "Drama" }, { id: 14, name: "Crime" }],
          contentRatings: [
            { id: 151, name: "16", country: "nld" },
            { id: 247, name: "TV-MA", country: "usa" },
          ],
          averageRuntime: 53,
          score: 157013, // real value — popularity count, NOT a 0-10 rating
          remoteIds: [{ id: "41889", type: 12, sourceName: "TheMovieDB.com" }, { id: "tt1830379", sourceName: "IMDB" }],
        },
      }));
    });
    const p = new TvdbProvider({ baseUrl: url });
    const d = await p.getDetails("253138");
    expect(path).toBe("/series/253138/extended");
    expect(d).toMatchObject({
      externalId: "253138", title: "Top Boy", releaseDate: "2011-10-31", year: 2011,
      overview: "east London drama", status: "Ended", genres: ["Drama", "Crime"],
      certification: "TV-MA", runtime: 53, tmdbId: 41889,
    });
    expect(d.images).toEqual([{ coverType: "poster", url: "https://artworks.thetvdb.com/banners/series/253138/posters/x.jpg" }]);
    expect(d.rating).toBeUndefined(); // score is not comparable to TMDB's vote_average
  });

  it("getDetails tolerates sparse records (no ratings/image/remoteIds)", async () => {
    const url = await listen((_u, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { id: 1, name: "Bare Show", contentRatings: null, remoteIds: null, seasons: [] } }));
    });
    const p = new TvdbProvider({ baseUrl: url });
    const d = await p.getDetails("1");
    expect(d.certification).toBeUndefined();
    expect(d.runtime).toBeUndefined();
    expect(d.tmdbId).toBeUndefined();
    expect(d.images).toEqual([]);
    expect(d.status).toBeUndefined();
  });

  it("seriesSeasons assembles official-order seasons + episodes and normalizes finaleType", async () => {
    const url = await listen((u, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      if (u.pathname === "/series/7/extended") {
        // The extended seasons list mixes every ordering; only `official` counts.
        res.end(JSON.stringify({
          data: {
            seasons: [
              { number: 1, type: { type: "official" } },
              { number: 2, type: { type: "official" } },
              { number: 0, type: { type: "official" } },
              { number: 1, type: { type: "dvd" } },
              { number: 1, type: { type: "absolute" } },
            ],
          },
        }));
        return;
      }
      // /series/7/episodes/official — two pages to prove pagination is reused
      if (u.searchParams.get("page") === "0") {
        res.end(JSON.stringify({
          data: {
            episodes: [
              { id: 21, seasonNumber: 2, number: 1, absoluteNumber: 3, aired: "2020-04-01", finaleType: null },
              { id: 11, seasonNumber: 1, number: 1, absoluteNumber: 1, aired: "2020-01-01", name: "Pilot", overview: "first", finaleType: null },
              { id: 12, seasonNumber: 1, number: 2, absoluteNumber: 2, aired: "2020-01-08", name: "Goodbye", overview: "", finaleType: "season" },
            ],
          },
          links: { next: "/series/7/episodes/official?page=1" },
        }));
      } else {
        res.end(JSON.stringify({
          data: {
            episodes: [
              { id: 22, seasonNumber: 2, number: 2, absoluteNumber: 4, aired: "2020-04-08", name: "The End", finaleType: "series" },
              { id: 23, seasonNumber: 2, number: 3, absoluteNumber: 5, aired: "2021-01-01", finaleType: "midseason" },
            ],
          },
          links: { next: null },
        }));
      }
    });
    const p = new TvdbProvider({ baseUrl: url });
    const seasons = await p.seriesSeasons("7");
    // official numbers sorted ascending; dvd/absolute orderings excluded
    expect(seasons.map((s) => s.seasonNumber)).toEqual([0, 1, 2]);
    expect(seasons[0].episodes).toEqual([]); // empty special season still present (TMDB parity)
    expect(seasons[1].episodes).toHaveLength(2);
    expect(seasons[1].episodes[0]).toMatchObject({ episodeNumber: 1, name: "Pilot", airDate: "2020-01-01" });
    expect(seasons[1].episodes[0].episodeType).toBeUndefined(); // regular episode
    expect(seasons[1].episodes[1].episodeType).toBeUndefined(); // plain "season" finales don't map
    expect(seasons[2].episodes.map((e) => e.episodeNumber)).toEqual([1, 2, 3]); // ordered within season
    expect(seasons[2].episodes[1].episodeType).toBe("finale"); // TVDB "series" -> "finale"
    expect(seasons[2].episodes[2].episodeType).toBe("mid_season"); // TVDB "midseason" -> "mid_season"
  });

  it("tmdbIdFromRemoteIds accepts only the verified TMDB source with a positive numeric id", async () => {
    expect(tmdbIdFromRemoteIds([{ id: "41889", sourceName: "TheMovieDB.com" }])).toBe(41889);
    expect(tmdbIdFromRemoteIds([{ id: "tt1830379", sourceName: "IMDB" }])).toBeUndefined(); // wrong source only
    expect(tmdbIdFromRemoteIds([{ id: "not-a-number", sourceName: "TheMovieDB.com" }])).toBeUndefined();
    expect(tmdbIdFromRemoteIds([{ id: "-5", sourceName: "TheMovieDB.com" }])).toBeUndefined();
    expect(tmdbIdFromRemoteIds(null)).toBeUndefined();
    expect(tmdbIdFromRemoteIds(undefined)).toBeUndefined();
  });
});
