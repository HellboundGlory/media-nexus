// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { TmdbProvider } from "./tmdb";

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });
async function listen(handler: (u: URL, res: import("node:http").ServerResponse) => void): Promise<string> {
  const s = createServer((_req, res) => handler(new URL(_req.url ?? "/", "http://127.0.0.1"), res));
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

describe("TmdbProvider", () => {
  it("searches movies and series", async () => {
    const url = await listen((u, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      if (u.pathname.startsWith("/search/movie")) res.end(JSON.stringify({ results: [{ id: 438631, title: "Dune", release_date: "2021-10-22", overview: "A mythic hero", genre_ids: [878, 12] }] }));
      else res.end(JSON.stringify({ results: [{ id: 71912, name: "The Witcher", first_air_date: "2019-12-20" }] }));
    });
    const p = new TmdbProvider({ apiKey: "k", baseUrl: url });
    const movies = await p.search("dune", "movie");
    expect(movies[0]).toMatchObject({ externalId: "438631", title: "Dune", year: 2021 });
    const tv = await p.search("witcher", "series");
    expect(tv[0].externalId).toBe("71912");
  });

  it("resolves tvdb<->tmdb ids and fetches all seasons + episodes", async () => {
    const url = await listen((u, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const seg = u.pathname.split("/").filter(Boolean);
      if (u.pathname.startsWith("/find/")) {
        const id = u.searchParams.get("external_source");
        if (id === "tvdb_id") { res.end(JSON.stringify({ tv_results: [{ id: 12345 }] })); return; }
        res.end(JSON.stringify({ tv_results: [] }));
      } else if (seg.includes("season")) {
        const n = Number(seg[seg.length - 1]);
        res.end(JSON.stringify({ season_number: n, episodes: [{ episode_number: 1, name: `S${n}E1`, air_date: "2021-01-01", overview: "ep" }] }));
      } else if (u.pathname.startsWith("/tv/")) {
        res.end(JSON.stringify({ id: 12345, name: "Show", number_of_seasons: 1, overview: "o", first_air_date: "2021-01-01", external_ids: { tvdb_id: 999 } }));
      }
    });
    const p = new TmdbProvider({ apiKey: "k", baseUrl: url });
    expect(await p.tmdbIdForTvdb(999)).toBe("12345");
    expect(await p.tvdbIdForTmdb(12345)).toBe(999);
    const seasons = await p.seriesSeasons(12345);
    expect(seasons.length).toBeGreaterThanOrEqual(2);
    const s1 = seasons.find((s) => s.season_number === 1);
    expect(s1?.episodes?.[0].name).toBe("S1E1");
  });

  it("returns details for a movie", async () => {
    const url = await listen((_u, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: 2, title: "Blade Runner", overview: "x", release_date: "1982-06-25", genres: [{ name: "Sci-Fi" }], poster_path: "/p.jpg" }));
    });
    const p = new TmdbProvider({ apiKey: "k", baseUrl: url });
    const d = await p.getDetails("movie", "2");
    expect(d.title).toBe("Blade Runner");
    expect(d.genres).toContain("Sci-Fi");
    expect(d.year).toBe(1982);
  });

  it("reads the collection from movie details: present when in a collection, undefined when not", async () => {
    let response: unknown;
    const url = await listen((_u, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
    });
    const p = new TmdbProvider({ apiKey: "k", baseUrl: url });

    // With a collection (Dune)
    response = { id: 438631, title: "Dune", belongs_to_collection: { id: 726871, name: "Dune Collection" } };
    const withColl = await p.getDetails("movie", "438631");
    expect(withColl.collectionTmdbId).toBe(726871);
    expect(withColl.collectionName).toBe("Dune Collection");

    // Without a collection (Fight Club) — comes back undefined, not null or an empty object
    response = { id: 550, title: "Fight Club", belongs_to_collection: null };
    const without = await p.getDetails("movie", "550");
    expect(without.collectionTmdbId).toBeUndefined();
    expect(without.collectionName).toBeUndefined();
  });

  it("parses movie detail fields: certification, runtime, studio, release dates, trailer, rating", async () => {
    let requested: string | null = null;
    const url = await listen((u, res) => {
      requested = u.search;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: 550, title: "Fight Club", runtime: 139, vote_average: 8.437,
        production_companies: [{ name: "Fox 2000 Pictures" }],
        release_dates: {
          results: [{
            iso_3166_1: "US",
            release_dates: [
              { type: 1, release_date: "1999-09-21T00:00:00.000Z", certification: "" },
              { type: 3, release_date: "1999-10-15T00:00:00.000Z", certification: "R" },
              { type: 4, release_date: "2026-05-12T00:00:00.000Z", certification: "R" },
              { type: 5, release_date: "2000-04-25T00:00:00.000Z", certification: "R" },
            ],
          }],
        },
        videos: { results: [
          { site: "YouTube", type: "Featurette", key: "V0Fqdb-smqo" },
          { site: "YouTube", type: "Trailer", key: "dfeUzm6KF4g" },
        ] },
      }));
    });
    const p = new TmdbProvider({ apiKey: "k", baseUrl: url });
    const d = await p.getDetails("movie", "550");
    expect(requested).toContain("append_to_response=release_dates%2Cvideos");
    expect(d.certification).toBe("R");
    expect(d.runtime).toBe(139);
    expect(d.studio).toBe("Fox 2000 Pictures");
    expect(d.inCinemas).toBe("1999-10-15T00:00:00.000Z");
    expect(d.digitalRelease).toBe("2026-05-12T00:00:00.000Z");
    expect(d.physicalRelease).toBe("2000-04-25T00:00:00.000Z");
    expect(d.trailerId).toBe("dfeUzm6KF4g"); // first YouTube Trailer, not the Featurette
    expect(d.rating).toBe(8.437);
  });

  it("parses series detail fields: certification, runtime (with episode_run_time fallback), trailer, rating", async () => {
    const url = await listen((u, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: 1399, name: "Game of Thrones", vote_average: 8.469,
        episode_run_time: [],
        last_episode_to_air: { runtime: 80 },
        content_ratings: { results: [{ iso_3166_1: "US", rating: "TV-MA" }, { iso_3166_1: "GB", rating: "18" }] },
        videos: { results: [{ site: "YouTube", type: "Trailer", key: "KPLWWIOCOOQ" }, { site: "YouTube", type: "Teaser", key: "hhqRmcsWqac" }] },
      }));
    });
    const p = new TmdbProvider({ apiKey: "k", baseUrl: url });
    const d = await p.getDetails("series", "1399");
    expect(d.certification).toBe("TV-MA"); // US preferred over GB
    expect(d.runtime).toBe(80); // empty episode_run_time -> last_episode_to_air.runtime
    expect(d.trailerId).toBe("KPLWWIOCOOQ");
    expect(d.rating).toBe(8.469);
    expect(d.studio).toBeUndefined(); // no studio concept for series
  });

  it("fetches credits: keeps ALL cast, filters crew to key jobs (movie)", async () => {
    let requested = "";
    const url = await listen((u, res) => {
      requested = u.pathname;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        cast: [
          { id: 819, name: "Edward Norton", character: "Narrator", order: 0, profile_path: "/a.jpg" },
          { id: 287, name: "Brad Pitt", character: "Tyler Durden", order: 1, profile_path: null },
        ],
        crew: [
          { id: 7467, name: "David Fincher", job: "Director", department: "Directing", profile_path: "/b.jpg" },
          { id: 999, name: "Jim Uhls", job: "Screenplay", department: "Writing" },
          { id: 1000, name: "Name", job: "Key Grip", department: "Camera" }, // must be dropped
          { id: 1001, name: "Other", job: "Best Boy Electric", department: "Lighting" }, // dropped
        ],
      }));
    });
    const p = new TmdbProvider({ apiKey: "k", baseUrl: url });
    const r = await p.getCredits("movie", "550");
    expect(requested).toBe("/movie/550/credits");
    // cast: all kept, order preserved, profileUrl built
    expect(r.cast).toHaveLength(2);
    expect(r.cast[0]).toMatchObject({ id: 819, name: "Edward Norton", character: "Narrator", order: 0, profileUrl: "https://image.tmdb.org/t/p/w185/a.jpg" });
    // profile_path null -> no profileUrl
    expect(r.cast[1].profileUrl).toBeUndefined();
    // crew: key jobs kept, non-key dropped
    expect(r.crew).toHaveLength(2);
    expect(r.crew.map((c) => c.job).sort()).toEqual(["Director", "Screenplay"]);
  });

  it("fetches series credits and keeps the curated crew subset", async () => {
    let requested = "";
    const url = await listen((u, res) => {
      requested = u.pathname;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        cast: [{ id: 22970, name: "Peter Dinklage", character: "Tyrion", order: 0 }],
        crew: [
          { id: 1, name: "EP1", job: "Executive Producer", department: "Production" },
          { id: 2, name: "Writer1", job: "Writer", department: "Writing" },
          { id: 3, name: "Staff W", job: "Staff Writer", department: "Writing" }, // dropped (not exact)
          { id: 4, name: "Junk", job: "Stunts", department: "Crew" }, // dropped
        ],
      }));
    });
    const p = new TmdbProvider({ apiKey: "k", baseUrl: url });
    const r = await p.getCredits("series", "1399");
    expect(requested).toBe("/tv/1399/credits");
    expect(r.cast).toHaveLength(1);
    // "Writer" kept, "Staff Writer" / "Stunts" dropped; Executive Producer kept
    expect(r.crew.map((c) => c.job).sort()).toEqual(["Executive Producer", "Writer"]);
  });
});

describe("TmdbProvider — TMDBPROXY (roadmap P3): shared-proxy vs own-key modes", () => {
  it("proxy mode (no apiKey) sends NO api_key query param — the Worker injects it", async () => {
    let query = "";
    const url = await listen((u, res) => {
      query = u.search;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ results: [] }));
    });
    const p = new TmdbProvider({ baseUrl: url });
    await p.search("dune", "movie");
    expect(query).not.toContain("api_key");
  });

  it("own-key mode sends api_key", async () => {
    let query = "";
    const url = await listen((u, res) => {
      query = u.search;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ results: [] }));
    });
    const p = new TmdbProvider({ apiKey: "k-secret-xyz", baseUrl: url });
    await p.search("dune", "movie");
    expect(query).toContain("api_key=k-secret-xyz");
  });
});
