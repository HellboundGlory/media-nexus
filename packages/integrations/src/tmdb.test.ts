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
});
