// SPDX-License-Identifier: MIT
/** MediaRepository is the seam the decision and import engines are built on. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, schema } from "@medianexus/database";
import { MediaRepository } from "../src/media/media.repository";

const dir = mkdtempSync(join(tmpdir(), "mn-mediarepo-"));
let handle: ReturnType<typeof createDb>;
let repo: MediaRepository;

beforeAll(async () => {
  handle = createDb(join(dir, "t.db"));
  handle.runMigrations();
  repo = new MediaRepository(handle.db);

  const now = new Date().toISOString();
  await handle.db.insert(schema.movie).values({
    id: "m1", tmdbId: 42, imdbId: null, title: "Arrival", originalTitle: null, overview: "",
    status: "released", releaseDate: "2016-11-11", monitored: true, qualityProfileId: null,
    rootFolderPath: "/media/movies", minimumAvailability: "released", genres: [], images: [],
    tags: ["4k"], hasFile: false, addedAt: now, updatedAt: now,
  });
  await handle.db.insert(schema.series).values({
    id: "s1", tvdbId: 7, tmdbId: null, imdbId: null, title: "Test Show", overview: "",
    status: "continuing", seriesType: "standard", network: "HBO", firstAirYear: 2019,
    monitored: true, qualityProfileId: null, rootFolderPath: "/media/tv", genres: [], images: [],
    tags: [], addedAt: now, updatedAt: now,
  });
  await handle.db.insert(schema.season).values([
    { id: "sea1", seriesId: "s1", seasonNumber: 1, monitored: true, qualityProfileId: null },
    { id: "sea2", seriesId: "s1", seasonNumber: 2, monitored: true, qualityProfileId: null },
  ]);
  await handle.db.insert(schema.episode).values([
    { id: "s1e1", seriesId: "s1", seasonId: "sea1", episodeNumber: 1, absoluteNumber: null, title: "", overview: "", airDateUtc: null, monitored: true, hasFile: false, sceneSeasonNumber: null, sceneEpisodeNumber: null },
    { id: "s1e2", seriesId: "s1", seasonId: "sea1", episodeNumber: 2, absoluteNumber: null, title: "", overview: "", airDateUtc: null, monitored: true, hasFile: false, sceneSeasonNumber: null, sceneEpisodeNumber: null },
    { id: "s2e1", seriesId: "s1", seasonId: "sea2", episodeNumber: 1, absoluteNumber: null, title: "", overview: "", airDateUtc: null, monitored: false, hasFile: true, sceneSeasonNumber: null, sceneEpisodeNumber: null },
  ]);
  await handle.db.insert(schema.mediaFile).values([
    { id: "mf1", mediaType: "series", mediaId: "s1", episodeIds: ["s2e1"], relativePath: "Test Show/Season 2/S02E01.mkv", size: 100, quality: { source: "web", resolution: "1080p", edition: "" }, mediaInfo: {}, languages: [], dateAdded: now },
    { id: "mf2", mediaType: "movie", mediaId: "m1", episodeIds: [], relativePath: "Arrival (2016)/Arrival.mkv", size: 200, quality: { source: "bluray", resolution: "2160p", edition: "" }, mediaInfo: {}, languages: [], dateAdded: now },
  ]);
});

afterAll(() => handle.close());

describe("MediaItem loading", () => {
  it("maps a movie row onto the unified shape", async () => {
    const item = await repo.get("movie", "m1");
    expect(item).toMatchObject({
      id: "m1", mediaType: "movie", title: "Arrival", year: 2016,
      minimumAvailability: "released", tags: ["4k"],
    });
  });

  it("maps a series row and derives the year from firstAirYear", async () => {
    const item = await repo.get("series", "s1");
    expect(item).toMatchObject({ mediaType: "series", title: "Test Show", year: 2019, seriesType: "standard" });
  });

  it("throws a 404-shaped error for a missing id", async () => {
    await expect(repo.get("movie", "nope")).rejects.toThrow(/not found/i);
    expect(await repo.find("series", "nope")).toBeNull();
  });
});

describe("release targeting", () => {
  it("maps a movie release straight to its movie", async () => {
    const target = await repo.resolveTarget("movie", "m1", "Arrival.2016.1080p.BluRay");
    expect(target).toEqual({ kind: "movie", mediaType: "movie", mediaId: "m1" });
  });

  it("resolves an episode within its own season only", async () => {
    const target = await repo.resolveTarget("series", "s1", "Test.Show.S01E01.1080p.WEB");
    expect(target?.kind).toBe("episode");
    expect(target && "episodes" in target && target.episodes.map((e) => e.id)).toEqual(["s1e1"]);
  });

  it("resolves a multi-episode release", async () => {
    const target = await repo.resolveTarget("series", "s1", "Test.Show.S01E01-E02.1080p.WEB");
    expect(target && "episodes" in target && target.episodes.map((e) => e.id).sort()).toEqual(["s1e1", "s1e2"]);
  });

  it("treats a season with no named episodes as a season pack covering every episode", async () => {
    const target = await repo.resolveTarget("series", "s1", "Test.Show.Season 1.1080p.WEB");
    expect(target?.kind).toBe("episode");
    if (target && target.kind === "episode") {
      expect(target.isSeasonPack).toBe(true);
      expect(target.episodes.map((e) => e.id).sort()).toEqual(["s1e1", "s1e2"]);
    }
  });

  it("returns null when the title carries no season at all", async () => {
    expect(await repo.resolveTarget("series", "s1", "Some.Unrelated.Movie.2016.1080p")).toBeNull();
  });

  it("returns null when the season exists in the title but not the library", async () => {
    expect(await repo.resolveTarget("series", "s1", "Test.Show.S09E01.1080p.WEB")).toBeNull();
  });
});

describe("existing files", () => {
  it("returns the movie's own files", async () => {
    const files = await repo.existingFiles({ kind: "movie", mediaType: "movie", mediaId: "m1" });
    expect(files.map((f) => f.id)).toEqual(["mf2"]);
    expect(files[0].quality).toMatchObject({ source: "bluray", resolution: "2160p" });
  });

  it("returns only files overlapping the targeted episodes", async () => {
    const covered = await repo.resolveTarget("series", "s1", "Test.Show.S02E01.1080p.WEB");
    expect(await repo.existingFiles(covered!)).toHaveLength(1);

    const uncovered = await repo.resolveTarget("series", "s1", "Test.Show.S01E01.1080p.WEB");
    expect(await repo.existingFiles(uncovered!)).toHaveLength(0);
  });
});
