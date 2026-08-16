// SPDX-License-Identifier: MIT
/**
 * Rename preview (DETAILPAGE-BE4) regression coverage. The whole value of these endpoints is
 * that newPath mirrors what the real import path (`acquisition.service.ts`) would assemble
 * under the current `media.naming` config — so every case asserts against the DB-inserted
 * `media_file.relativePath` (built the way import builds it), never against real files on disk.
 *
 * The naming builders are pure (packages/domain naming.ts) — the service layer just feeds them
 * the real DB rows the same way acquisition does, which is what we lock in here.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "@medianexus/events";
import { createDb, schema } from "@medianexus/database";
import { ConfigService } from "../src/system/config.service";
import { EventsService } from "../src/events/events.service";
import { AutoTagsService } from "../src/auto-tags/auto-tags.service";
import { MoviesService } from "../src/movies/movies.service";
import { SeriesService } from "../src/series/series.service";
import type { Db } from "@medianexus/database";

const dir = mkdtempSync(join(tmpdir(), "mn-rename-preview-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });

async function makeDb() {
  const handle = createDb(join(dir, `rename-${handles.length}.db`));
  handle.runMigrations();
  handles.push(handle);
  return handle.db;
}

async function makeServices() {
  const db = await makeDb();
  const config = new ConfigService(db);
  const events = new EventsService(new EventBus());
  const autoTags = new AutoTagsService(db);
  const movies = new MoviesService(db, events, autoTags, config);
  const series = new SeriesService(db, events, autoTags, config);
  return { db, config, movies, series };
}

/** Build a media_file row exactly as import's default movie template would name it. */
function movieFilePath(title: string, year: string | null | undefined, ext = ".mkv") {
  return `${title} (${year ?? "Unknown"})/${title} (${year ?? "Unknown"})${ext}`;
}

/** Build a media_file row path as import's default episode template would name it (single-ep). */
function episodeFilePath(title: string, season: number, ep: number, epTitle: string): string {
  return `${title}/Season ${season}/${title} - S${String(season).padStart(2, "0")}E${String(ep).padStart(2, "0")} - ${epTitle}.mkv`;
}

async function seedMovie(db: Db, _quality: Record<string, string> = { source: "bluray", resolution: "1080p", edition: "" }) {
  const now = new Date().toISOString();
  await db.insert(schema.movie).values({
    id: "m1", tmdbId: 1, imdbId: null, title: "Fight Club", originalTitle: null, overview: "",
    status: "released", releaseDate: "1999-10-15", monitored: true, qualityProfileId: null,
    rootFolderPath: "", minimumAvailability: "released", genres: [], images: [], tags: [],
    hasFile: true, addedAt: now, updatedAt: now,
  });
  return { id: "m1" };
}

async function seedSeries(db: Db, _quality: Record<string, string> = { source: "web", resolution: "1080p", edition: "" }) {
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
  return { id: "s1" };
}

function mediaFile(id: string, mediaType: "movie" | "series", mediaId: string, relativePath: string, episodeIds: string[], quality: Record<string, string>): typeof schema.mediaFile.$inferInsert {
  return { id, mediaType, mediaId, episodeIds, relativePath, size: 1000, quality, dateAdded: new Date().toISOString() };
}

describe("rename-preview (DETAILPAGE-BE4)", () => {
  it("movie + series: unchanged when current path already matches the naming template", async () => {
    const { db, movies, series } = await makeServices();
    await seedMovie(db);
    await seedSeries(db);
    // Files named exactly as the DEFAULT template produces them.
    await db.insert(schema.mediaFile).values([
      mediaFile("mf_m1", "movie", "m1", movieFilePath("Fight Club", "1999"), [], { source: "bluray", resolution: "1080p", edition: "" }),
      mediaFile("mf_s1", "series", "s1", episodeFilePath("Game of Thrones", 1, 1, "Winter Is Coming"), ["s1e1"], { source: "web", resolution: "1080p", edition: "" }),
    ]);

    const moviePrev = await movies.renamePreview("m1");
    expect(moviePrev.rootPath).toBe("Fight Club (1999)");
    expect(moviePrev.namingPattern).toBe("{Movie Title} ({Release Year})");
    expect(moviePrev.items).toEqual([{ mediaFileId: "mf_m1", currentPath: movieFilePath("Fight Club", "1999"), newPath: movieFilePath("Fight Club", "1999"), changed: false }]);

    const seriesPrev = await series.renamePreview("s1");
    expect(seriesPrev.rootPath).toBe("Game of Thrones");
    expect(seriesPrev.namingPattern).toBe("{Series Title} - S{season:00}E{episode:00} - {Episode Title}");
    expect(seriesPrev.items).toEqual([{ mediaFileId: "mf_s1", currentPath: episodeFilePath("Game of Thrones", 1, 1, "Winter Is Coming"), newPath: episodeFilePath("Game of Thrones", 1, 1, "Winter Is Coming"), changed: false }]);
  });

  it("movie + series: changed to true and newPath reflects a new template after a config change", async () => {
    const { db, config, movies, series } = await makeServices();
    await seedMovie(db);
    await seedSeries(db);
    await db.insert(schema.mediaFile).values([
      mediaFile("mf_m1", "movie", "m1", movieFilePath("Fight Club", "1999"), [], { source: "bluray", resolution: "1080p", edition: "" }),
      mediaFile("mf_s1", "series", "s1", episodeFilePath("Game of Thrones", 1, 1, "Winter Is Coming"), ["s1e1"], { source: "web", resolution: "1080p", edition: "" }),
    ]);

    // Change the naming templates: movie drops the year, episode drops the episode title.
    await config.upsert({
      "media.naming": {
        movies: "{Movie Title}",
        episodes: "{Series Title} S{season:00}E{episode:00}",
      },
    } as never);

    const moviePrev = await movies.renamePreview("m1");
    expect(moviePrev.items).toEqual([{ mediaFileId: "mf_m1", currentPath: movieFilePath("Fight Club", "1999"), newPath: "Fight Club (1999)/Fight Club.mkv", changed: true }]);
    expect(moviePrev.namingPattern).toBe("{Movie Title}");

    // Series: folder (fixed convention) unchanged, filename now S01E01 without the title.
    const seriesPrev = await series.renamePreview("s1");
    expect(seriesPrev.items).toEqual([{ mediaFileId: "mf_s1", currentPath: episodeFilePath("Game of Thrones", 1, 1, "Winter Is Coming"), newPath: "Game of Thrones/Season 1/Game of Thrones S01E01.mkv", changed: true }]);
    expect(seriesPrev.namingPattern).toBe("{Series Title} S{season:00}E{episode:00}");
  });

  it("series: a file with no episodeIds (unmatched pack member) is always reported unchanged", async () => {
    const { db, config, series } = await makeServices();
    await seedSeries(db);
    await db.insert(schema.mediaFile).values([
      mediaFile("mf_unmatched", "series", "s1", "Game of Thrones/Season 1/unmatched-0.mkv", [], { source: "web", resolution: "1080p", edition: "" }),
    ]);

    // Regardless of the template, no episode identity means no template name to build from.
    await config.upsert({ "media.naming": { episodes: "completely different template" } } as never);
    const prev = await series.renamePreview("s1");
    expect(prev.items).toEqual([{ mediaFileId: "mf_unmatched", currentPath: "Game of Thrones/Season 1/unmatched-0.mkv", newPath: "Game of Thrones/Season 1/unmatched-0.mkv", changed: false }]);
  });

  it("series: multi-episode file renders the Sonarr range style (S01E01-02)", async () => {
    const { db, config, series } = await makeServices();
    await seedSeries(db);
    // A file covering episodes 1+2: default template renders S01E01-02 (range) + joined titles.
    await db.insert(schema.mediaFile).values([
      mediaFile("mf_pack", "series", "s1", "Game of Thrones/Season 1/Game of Thrones - S01E01-02 - Winter Is Coming + The Kingsroad.mkv", ["s1e1", "s1e2"], { source: "web", resolution: "1080p", edition: "" }),
    ]);

    const prev = await series.renamePreview("s1");
    expect(prev.items).toEqual([{ mediaFileId: "mf_pack", currentPath: "Game of Thrones/Season 1/Game of Thrones - S01E01-02 - Winter Is Coming + The Kingsroad.mkv", newPath: "Game of Thrones/Season 1/Game of Thrones - S01E01-02 - Winter Is Coming + The Kingsroad.mkv", changed: false }]);

    // Flip the template to prove the range rendering tracks it (episode tokens only -> S01E01-02).
    await config.upsert({ "media.naming": { episodes: "{Series Title} S{season:00}E{episode:00}" } } as never);
    const changed = await series.renamePreview("s1");
    expect(changed.items).toEqual([{ mediaFileId: "mf_pack", currentPath: "Game of Thrones/Season 1/Game of Thrones - S01E01-02 - Winter Is Coming + The Kingsroad.mkv", newPath: "Game of Thrones/Season 1/Game of Thrones S01E01-02.mkv", changed: true }]);
  });
});
