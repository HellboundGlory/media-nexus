// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { buildSeerrV1Surface, seerrStatus, type SeerrNativeSource } from "./seerr";

const source: SeerrNativeSource = {
  version: () => "0.9.0",
  commitTag: () => "abc123",
  totals: async () => ({ requests: 3, movies: 2, tv: 1 }),
  settingsPublic: async () => ({ initialized: true, onboarding: true, locale: "en", region: "US", originalLanguage: "en", appName: "MediaNexus", url: "http://localhost", emailEnabled: false }),
  login: async (u, p) => (u === "admin" && p === "pw" ? { id: "user_admin", email: "admin@localhost", username: "admin", permissions: 2, requestCount: 1, avatar: "", token: "tok123" } : null),
  me: async () => ({ id: "user_admin", email: "admin@localhost", username: "admin", permissions: 2, requestCount: 1, avatar: "" }),
  logout: async () => {},
  listRequests: async (_page, _take) => ({
    items: [{ id: "r1", mediaId: "603", mediaType: "movie", status: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }],
    total: 1,
  }),
  createRequest: async (mt, mediaId) => ({ id: "r_new", mediaId, mediaType: mt, status: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }),
  media: async (tmdbId) => ({ id: `m_${tmdbId}`, title: "Dune", mediaType: "movie", tmdbId: Number(tmdbId), status: "available", year: 2021 }),
  discover: async (mt) => [{ id: "m1", title: "Dune", mediaType: mt, tmdbId: 438631, status: "available", year: 2021 }],
  search: async (q) => [{ id: "m1", title: q, mediaType: "movie", tmdbId: 1, year: 2024 }],
};

describe("seerr v1 surface", () => {
  const surface = buildSeerrV1Surface(source);

  it("serves status + settings/public", async () => {
    const st = await surface.match("GET", "/api/seerr/v1/status")!.route.handler({} as never);
    expect(st.body).toMatchObject({ version: "0.9.0", totalMovies: 2, totalTv: 1 });
    const set = await surface.match("GET", "/api/seerr/v1/settings/public")!.route.handler({} as never);
    expect((set.body as any).appName).toBe("MediaNexus");
    expect((set.body as any).initialized).toBe(true);
  });

  it("logs in locally and resolves the session user", async () => {
    const login = await surface.match("POST", "/api/seerr/v1/auth/local")!.route.handler({ body: { username: "admin", password: "pw" } } as never);
    expect(login.status).toBe(200);
    expect((login.body as any).username).toBe("admin");
    expect((login.body as any).token).toBeTruthy();
    const bad = await surface.match("POST", "/api/seerr/v1/auth/local")!.route.handler({ body: { username: "admin", password: "nope" } } as never);
    expect(bad.status).toBe(401);
  });

  it("lists and creates requests in the Seerr shape", async () => {
    const list = await surface.match("GET", "/api/seerr/v1/request")!.route.handler({ query: { page: "1", take: "20" } } as never);
    expect((list.body as any).results[0]).toMatchObject({ id: "r1", mediaId: "603", status: 1 });
    expect((list.body as any).pageInfo.resultsPerPage).toBe(20);
    const created = await surface.match("POST", "/api/seerr/v1/request")!.route.handler({ body: { mediaType: "movie", mediaId: "603" } } as never);
    expect(created.status).toBe(201);
    expect((created.body as any).mediaId).toBe("603");
  });

  it("serves media + discover + search", async () => {
    const media = await surface.match("GET", "/api/seerr/v1/media/438631")!.route.handler({ params: { tmdbId: "438631" } } as never);
    expect((media.body as any).title).toBe("Dune");
    const disc = await surface.match("GET", "/api/seerr/v1/discover/movies")!.route.handler({ query: {} } as never);
    expect((disc.body as any[])[0].mediaType).toBe("movie");
    const s = await surface.match("GET", "/api/seerr/v1/search")!.route.handler({ query: { query: "inception" } } as never);
    expect((s.body as any[])[0].title).toBe("inception");
  });

  it("maps native request status to Seerr status codes", () => {
    expect(seerrStatus("pending")).toBe(1);
    expect(seerrStatus("approved")).toBe(2);
    expect(seerrStatus("declined")).toBe(3);
    expect(seerrStatus("processing")).toBe(4);
    expect(seerrStatus("failed")).toBe(5);
    expect(seerrStatus("fulfilled")).toBe(6);
  });
});
