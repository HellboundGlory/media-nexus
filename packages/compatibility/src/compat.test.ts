// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { buildSonarrV3SurfaceSource } from "./sonarr";
import { buildRadarrV3Surface } from "./radarr";
import { buildProwlarrV1Surface } from "./prowlarr";
import type { SonarrNativeSource } from "./sonarr";
import type { RadarrNativeSource } from "./radarr";
import type { ProwlarrNativeSource } from "./prowlarr";

const sonarrSource: SonarrNativeSource = {
  appVersion: () => "0.8.0",
  appName: () => "MediaNexus",
  started: () => "2026-01-01T00:00:00Z",
  databaseVersion: () => "1",
  listSeries: async () => [{
    id: "s1", title: "Severance", tvdbId: 405861, seriesType: "standard", year: 2022,
    path: "/media/Severance", monitored: true, qualityProfileId: "qp_hd", status: "continuing",
    seasons: [{ seasonNumber: 1, monitored: true }], added: "2026-01-01T00:00:00Z",
  }],
  getSeries: async (id) => (id === "s1" ? (await sonarrSource.listSeries())[0] : null),
  addSeries: async (input) => ({ id: "s_new", title: String(input.title), tvdbId: Number(input.tvdbId), seriesType: "standard", year: null, path: String(input.rootFolderPath ?? ""), monitored: true, qualityProfileId: "qp_hd", status: "continuing" }),
  removeSeries: async () => {},
  qualityProfiles: async () => [{ id: "qp_hd", name: "HD-1080p", upgradeAllowed: true, cutoff: 3, items: [] }],
  episodes: async () => [{ id: "e1", seriesId: "s1", seasonNumber: 1, episodeNumber: 1, title: "Good News About Hell", airDateUtc: "2022-02-18T00:00:00Z", monitored: true, hasFile: false }],
  runCommand: async (name) => ({ id: "cmd1", name }),
};

const radarrSource: RadarrNativeSource = {
  appVersion: () => "0.8.0", appName: () => "MediaNexus", started: () => "2026-01-01T00:00:00Z", databaseVersion: () => "1",
  listMovies: async () => [{ id: "m1", title: "Dune", tmdbId: 438631, status: "released", year: 2021, path: "/media/Dune", monitored: true, qualityProfileId: "qp_hd", hasFile: false }],
  getMovie: async (id) => (id === "m1" ? (await radarrSource.listMovies())[0] : null),
  addMovie: async (input) => ({ id: "m_new", title: String(input.title), tmdbId: Number(input.tmdbId), status: "released", year: null, path: String(input.rootFolderPath ?? ""), monitored: true, qualityProfileId: "qp_hd", hasFile: false }),
  removeMovie: async () => {},
  qualityProfiles: async () => [{ id: "qp_hd", name: "HD-1080p", upgradeAllowed: true, cutoff: 3, items: [] }],
  runCommand: async (name) => ({ id: "cmd1", name }),
};

const prowlarrSource: ProwlarrNativeSource = {
  appVersion: () => "0.8.0", appName: () => "MediaNexus", started: () => "2026-01-01T00:00:00Z", databaseVersion: () => "1",
  listIndexers: async () => [{
    id: "idx1", name: "Nzbgeek", fields: [{ name: "baseUrl", value: "https://nzbgeek.info" }],
    implementation: "Newznab", protocol: "usenet", tags: [], definitionName: "NZBgeek", configContract: "NewznabSettings",
  }],
  search: async (query) => [{
    guid: "g1", title: `Show.${query}.2024.1080p.WEB-DL`, size: 9000000000, seeders: 5, indexer: "Nzbgeek",
    indexerId: "idx1", categories: [5030], protocol: "usenet", downloadUrl: "https://nzb/1.nzb",
  }],
};

describe("sonarr v3 surface", () => {
  const surface = buildSonarrV3SurfaceSource(sonarrSource);
  it("lists series in the Sonarr wire shape", async () => {
    const hit = surface.match("GET", "/api/sonarr/v3/series")!;
    const res = await hit.route.handler(hit.ctx);
    const body = res.body as any[];
    expect(res.status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).toMatchObject({ title: "Severance", tvdbId: 405861, seriesType: "standard", seasons: [{ seasonNumber: 1, monitored: true }] });
  });
  it("adds a series and lists episodes", async () => {
    const addHit = surface.match("POST", "/api/sonarr/v3/series")!;
    const added = await addHit.route.handler({ ...addHit.ctx, body: { title: "New Show", tvdbId: 999999, rootFolderPath: "/media" } } as never);
    expect(added.status).toBe(201);
    expect((added.body as any).title).toBe("New Show");
    const epHit = surface.match("GET", "/api/sonarr/v3/episode")!;
    const eps = await epHit.route.handler({ ...epHit.ctx, query: { seriesId: "s1" } } as never);
    expect((eps.body as any[])[0].hasFile).toBe(false);
  });
  it("GET qualityprofile and POST command return upstream shapes", async () => {
    const qp = await surface.match("GET", "/api/sonarr/v3/qualityprofile")!.route.handler({} as never);
    expect((qp.body as any[])[0].name).toBe("HD-1080p");
    const cmd = await surface.match("POST", "/api/sonarr/v3/command")!.route.handler({ ...{} as never, body: { name: "SeriesSearch" } } as never);
    expect((cmd.body as any).name).toBe("SeriesSearch");
  });
});

describe("radarr v3 surface", () => {
  const surface = buildRadarrV3Surface(radarrSource);
  it("lists and adds movies in the Radarr shape", async () => {
    const list = await surface.match("GET", "/api/radarr/v3/movie")!.route.handler({} as never);
    expect((list.body as any[])[0]).toMatchObject({ title: "Dune", tmdbId: 438631 });
    const added = await surface.match("POST", "/api/radarr/v3/movie")!.route.handler({ body: { title: "Blade Runner", tmdbId: 335984 } } as never);
    expect((added.body as any).title).toBe("Blade Runner");
  });
});

describe("prowlarr v1 surface", () => {
  const surface = buildProwlarrV1Surface(prowlarrSource);
  it("lists configured indexers in the Prowlarr shape", async () => {
    const hit = surface.match("GET", "/api/prowlarr/v1/indexer")!;
    const res = await hit.route.handler(hit.ctx);
    const body = (res.body as any[])[0];
    expect(body).toMatchObject({ name: "Nzbgeek", implementation: "Newznab", protocol: "usenet", configContract: "NewznabSettings" });
    expect(Array.isArray(body.fields)).toBe(true);
  });
  it("proxies an indexer search into normalized results", async () => {
    const hit = surface.match("GET", "/api/prowlarr/v1/indexer/idx1/search")!;
    const res = await hit.route.handler({ ...hit.ctx, query: { query: "dune" } } as never);
    const item = (res.body as any[])[0];
    expect(item).toMatchObject({ indexer: "Nzbgeek", protocol: "usenet", categories: [5030] });
    expect(item.title).toContain("dune");
    expect(item.size).toBe(9000000000);
  });
});
