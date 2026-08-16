// SPDX-License-Identifier: MIT
/**
 * Regression coverage for the /files subresources added by DETAILPAGE-FE1 (the one backend
 * add-on bundled inside that frontend task, per claude-lead). Locks in:
 *   - GET /movies/:id/files returns the movie's media_file rows (movie has no episodeIds);
 *   - GET /series/:id/files returns rows whose episodeIds let a consumer attribute each file
 *     to its season (the season size-on-disk computation depends on exactly this).
 * Real DB via createDb/runMigrations, no mocks (repo convention).
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inArray } from "drizzle-orm";
import { EventBus } from "@medianexus/events";
import { createDb, schema } from "@medianexus/database";
import { ConfigService } from "../src/system/config.service";
import { EventsService } from "../src/events/events.service";
import { AutoTagsService } from "../src/auto-tags/auto-tags.service";
import { MoviesService } from "../src/movies/movies.service";
import { SeriesService } from "../src/series/series.service";

const dir = mkdtempSync(join(tmpdir(), "mn-files-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });

async function makeServices() {
  const handle = createDb(join(dir, `files-${handles.length}.db`));
  handle.runMigrations();
  handles.push(handle);
  const config = new ConfigService(handle.db);
  const events = new EventsService(new EventBus());
  const autoTags = new AutoTagsService(handle.db);
  const movies = new MoviesService(handle.db, events, autoTags, config);
  const series = new SeriesService(handle.db, events, autoTags, config);
  return { db: handle.db, movies, series };
}

function mediaFile(id: string, mediaType: "movie" | "series", mediaId: string, relativePath: string): typeof schema.mediaFile.$inferInsert {
  return {
    id, mediaType, mediaId, relativePath, size: 1000,
    quality: { source: "bluray", resolution: "1080p", edition: "" },
    mediaInfo: { videoCodec: "h264", audioCodec: "aac", resolution: "1920x1080", runtimeSeconds: 7200, audioChannels: 6, subtitles: [] },
    languages: ["eng"], dateAdded: new Date().toISOString(),
  };
}

describe("/files subresources (DETAILPAGE-FE1)", () => {
  it("movie: returns the movie's media_file rows (no episodeIds)", async () => {
    const { db, movies } = await makeServices();
    const now = new Date().toISOString();
    await db.insert(schema.movie).values({
      id: "m1", tmdbId: 1, imdbId: null, title: "Fight Club", originalTitle: null, overview: "",
      status: "released", releaseDate: "1999-10-15", monitored: true, qualityProfileId: null,
      rootFolderPath: "", minimumAvailability: "released", genres: [], images: [], tags: [],
      hasFile: true, addedAt: now, updatedAt: now,
    });
    await db.insert(schema.mediaFile).values([
      mediaFile("mf1", "movie", "m1", "Fight Club (1999)/Fight Club (1999).mkv"),
      mediaFile("mf2", "movie", "m1", "Fight Club (1999)/Fight Club (1999)-extras.mkv"),
    ]);

    const files = await movies.files("m1");
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ id: "mf1", mediaType: "movie", mediaId: "m1", episodeIds: [], size: 1000, relativePath: "Fight Club (1999)/Fight Club (1999).mkv" });
    // mediaInfo normalized onto the precise shape (codec survives the JSON -> MediaInfo mapping)
    expect(files[0]?.mediaInfo?.videoCodec).toBe("h264");
    expect(files[0]?.quality).toMatchObject({ source: "bluray", resolution: "1080p" });
  });

  it("series: returns files carrying episodeIds so one can attribute them to a season", async () => {
    const { db, series } = await makeServices();
    const now = new Date().toISOString();
    await db.insert(schema.series).values({
      id: "s1", tvdbId: 1, tmdbId: null, imdbId: null, title: "Game of Thrones", overview: "",
      status: "ended", seriesType: "standard", network: null, firstAirYear: 2011,
      monitored: true, qualityProfileId: null, rootFolderPath: "", genres: [], images: [],
      tags: [], alternateTitles: [], addedAt: now, updatedAt: now,
    });
    await db.insert(schema.season).values([
      { id: "sea1", seriesId: "s1", seasonNumber: 1, monitored: true, qualityProfileId: null },
      { id: "sea2", seriesId: "s1", seasonNumber: 2, monitored: true, qualityProfileId: null },
    ]);
    await db.insert(schema.episode).values([
      { id: "s1e1", seriesId: "s1", seasonId: "sea1", episodeNumber: 1, absoluteNumber: null, title: "Winter Is Coming", overview: "", airDateUtc: null, monitored: true, hasFile: false, sceneSeasonNumber: null, sceneEpisodeNumber: null },
      { id: "s1e2", seriesId: "s1", seasonId: "sea1", episodeNumber: 2, absoluteNumber: null, title: "The Kingsroad", overview: "", airDateUtc: null, monitored: true, hasFile: false, sceneSeasonNumber: null, sceneEpisodeNumber: null },
      { id: "s2e1", seriesId: "s1", seasonId: "sea2", episodeNumber: 1, absoluteNumber: null, title: "The North Remembers", overview: "", airDateUtc: null, monitored: true, hasFile: false, sceneSeasonNumber: null, sceneEpisodeNumber: null },
    ]);
    // Season 1's file covers episodes 1+2; one separate season 2 file.
    await db.insert(schema.mediaFile).values([
      mediaFile("mf_s1", "series", "s1", "Game of Thrones/Season 1/GoT - S01E01-02.mkv"),
      mediaFile("mf_s2", "series", "s1", "Game of Thrones/Season 2/GoT - S02E01.mkv"),
    ]);
    // Point the covered episodes at their file — the FK is the coverage source (roadmap J3).
    await db.update(schema.episode).set({ mediaFileId: "mf_s1" }).where(inArray(schema.episode.id, ["s1e1", "s1e2"]));
    await db.update(schema.episode).set({ mediaFileId: "mf_s2" }).where(inArray(schema.episode.id, ["s2e1"]));

    const files = await series.files("s1");
    expect(files).toHaveLength(2);

    // A consumer can attribute each file to a season by intersecting episodeIds with the
    // already-fetched episode->seasonNumber mapping (what the season size pill does).
    const epSeason = new Map<string, number>([["s1e1", 1], ["s1e2", 1], ["s2e1", 2]]);
    const sizeBySeason = new Map<number, number>();
    for (const f of files) {
      const season = epSeason.get(f.episodeIds[0]!);
      if (season === undefined) continue;
      sizeBySeason.set(season, (sizeBySeason.get(season) ?? 0) + f.size);
    }
    expect(sizeBySeason.get(1)).toBe(1000); // mf_s1 (1000) attributed to season 1
    expect(sizeBySeason.get(2)).toBe(1000); // mf_s2 (1000) attributed to season 2

    const s1file = files.find((f) => f.id === "mf_s1");
    expect(s1file?.episodeIds).toEqual(["s1e1", "s1e2"]);
    expect(s1file?.mediaInfo?.videoCodec).toBe("h264");
  });

  it("not found: both endpoints throw ApiError.notFound for a missing title", async () => {
    const { movies, series } = await makeServices();
    await expect(movies.files("nope")).rejects.toThrow();
    await expect(series.files("nope")).rejects.toThrow();
  });
});
