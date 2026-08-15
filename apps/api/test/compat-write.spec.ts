// SPDX-License-Identifier: MIT
/** P2 item 8 — compat write surfaces: PUT series/movie + episode monitor end-to-end
 *  through the real CompatService → native services → DB. */
import { AutoTagsService } from "../src/auto-tags/auto-tags.service";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@medianexus/database";
import { CompatService } from "../src/compat/compat.service";
import { SeriesService } from "../src/series/series.service";
import { MoviesService } from "../src/movies/movies.service";
import { EventsService } from "../src/events/events.service";
import { EventBus } from "@medianexus/events";

const dir = mkdtempSync(join(tmpdir(), "mn-compat-write-"));
let handle: ReturnType<typeof createDb>;
let db: ReturnType<typeof createDb>["db"];
let svc: CompatService;

beforeAll(async () => {
  handle = createDb(join(dir, "c.db"));
  handle.runMigrations();
  db = handle.db;
  const events = new EventsService(new EventBus());
  const series = new SeriesService(db, events, new AutoTagsService(db));
  const movies = new MoviesService(db, events, new AutoTagsService(db));
  svc = new CompatService(
    db,
    { status: () => ({ version: "0.8.0", name: "MediaNexus", started: "2026-01-01T00:00:00Z", db: "1" }) } as never,
    series,
    movies,
    {} as never,
    {} as never,
  );

  const now = new Date().toISOString();
  await db.insert(schema.series).values({
    id: "sput", tvdbId: 1, tmdbId: 1, title: "PUT Show", overview: "added via compat",
    status: "continuing", seriesType: "standard", network: null, firstAirYear: 2020,
    monitored: true, qualityProfileId: null, rootFolderPath: "/media/PUT", genres: [], images: [],
    tags: ["tag_keep"], addedAt: now, updatedAt: now,
  });
  await db.insert(schema.season).values([
    { id: "sea1", seriesId: "sput", seasonNumber: 1, monitored: true },
    { id: "sea2", seriesId: "sput", seasonNumber: 2, monitored: true },
  ]);
  await db.insert(schema.episode).values([
    { id: "e1", seriesId: "sput", seasonId: "sea1", episodeNumber: 1, monitored: true, hasFile: false, airDateUtc: null, title: "E1", overview: "" },
    { id: "e2", seriesId: "sput", seasonId: "sea1", episodeNumber: 2, monitored: true, hasFile: false, airDateUtc: null, title: "E2", overview: "" },
    { id: "e3", seriesId: "sput", seasonId: "sea2", episodeNumber: 1, monitored: true, hasFile: false, airDateUtc: null, title: "E3", overview: "" },
  ]);
  await db.insert(schema.movie).values({
    id: "mput", tmdbId: 2, imdbId: null, title: "PUT Movie", overview: "m", originalTitle: null,
    status: "released", releaseDate: "2021-01-01", monitored: true, qualityProfileId: null,
    minimumAvailability: "announced", rootFolderPath: "/media/PUTM", genres: [], images: [],
    tags: [], addedAt: now, updatedAt: now,
  });
});

afterAll(() => handle.close());

async function route(surfaceName: string, path: string, body?: unknown, use = "PUT") {
  const surface = svc.surfaces.find((s) => s.name === surfaceName)!;
  const hit = surface.match(use as never, path);
  if (!hit) throw new Error(`no route for ${use} ${path}`);
  return hit.route.handler({ ...hit.ctx, body } as never);
}

describe("compat write surfaces", () => {
  it("PUT /series/:id updates monitored, qualityProfileId, tags and cascades season monitoring", async () => {
    const res = await route("sonarr-v3", "/api/sonarr/v3/series/sput", {
      monitored: false,
      qualityProfileId: null,
      tags: ["tag_new"],
      seasons: [{ seasonNumber: 1, monitored: false }],
    });
    expect(res.status).toBe(200);

    const series = (await db.select().from(schema.series).where(eq(schema.series.id, "sput")))[0];
    expect(series.monitored).toBe(false);
    expect(series.tags).toEqual(["tag_new"]);
    // season cascade: season 1 + its episodes flipped, season 2 untouched
    const sea1 = (await db.select().from(schema.season).where(eq(schema.season.id, "sea1")))[0];
    const sea2 = (await db.select().from(schema.season).where(eq(schema.season.id, "sea2")))[0];
    expect(sea1.monitored).toBe(false);
    expect(sea2.monitored).toBe(true);
    const e1 = (await db.select().from(schema.episode).where(eq(schema.episode.id, "e1")))[0];
    const e2 = (await db.select().from(schema.episode).where(eq(schema.episode.id, "e2")))[0];
    const e3 = (await db.select().from(schema.episode).where(eq(schema.episode.id, "e3")))[0];
    expect(e1.monitored).toBe(false);
    expect(e2.monitored).toBe(false);
    expect(e3.monitored).toBe(true);
  });

  it("PUT /episode/monitor flips episode monitoring without touching the season", async () => {
    const res = await route("sonarr-v3", "/api/sonarr/v3/episode/monitor", { seriesId: "sput", episodeIds: ["e3"], monitored: false });
    expect(res.status).toBe(200);

    const e3 = (await db.select().from(schema.episode).where(eq(schema.episode.id, "e3")))[0];
    expect(e3.monitored).toBe(false);
    const sea2 = (await db.select().from(schema.season).where(eq(schema.season.id, "sea2")))[0];
    expect(sea2.monitored).toBe(true); // season-level flag unchanged
  });

  it("PUT /movie/:id updates monitored and minimumAvailability (Radarr enum mapped)", async () => {
    const res = await route("radarr-v3", "/api/radarr/v3/movie/mput", { monitored: false, minimumAvailability: "released" });
    expect(res.status).toBe(200);
    const movie = (await db.select().from(schema.movie).where(eq(schema.movie.id, "mput")))[0];
    expect(movie.monitored).toBe(false);
    expect(movie.minimumAvailability).toBe("released");
  });

  it("addMovie / addSeries pass through overview/tags and map minimumAvailability", async () => {
    const addedMovie = await route("radarr-v3", "/api/radarr/v3/movie", {
      title: "In Cinemas Flick", tmdbId: 33, rootFolderPath: "/media/f", overview: "real overview", tags: ["t1"], minimumAvailability: "inCinemas",
    }, "POST");
    expect(addedMovie.status).toBe(201);
    const m = (await db.select().from(schema.movie).where(eq(schema.movie.tmdbId, 33)))[0];
    expect(m.overview).toBe("real overview");
    expect(m.tags).toEqual(["t1"]);
    expect(m.minimumAvailability).toBe("in_cinemas"); // Radarr camelCase -> our snake_case

    const addedSeries = await route("sonarr-v3", "/api/sonarr/v3/series", {
      title: "Ser Show", tvdbId: 44, rootFolderPath: "/media/s", overview: "ser ov", tags: ["t2"],
    }, "POST");
    expect(addedSeries.status).toBe(201);
    const s = (await db.select().from(schema.series).where(eq(schema.series.tvdbId, 44)))[0];
    expect(s.overview).toBe("ser ov");
    expect(s.tags).toEqual(["t2"]);
  });
});
