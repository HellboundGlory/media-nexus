// SPDX-License-Identifier: MIT
/**
 * Roadmap P3, gap report C8 (/parse sub-item) — GET /api/v1/system/parse (backed by ParseService).
 *
 * Read-only debug: run a raw release title through the existing domain parsers and surface what
 * was extracted, so an operator can see why a release isn't matching. Exercises ParseService
 * against a real SQLite DB (the same focused-spec pattern as edit.spec.ts) with real-shaped titles,
 * asserting the extracted season/episode, daily date, year and quality fields, plus the best-effort
 * library match and language detection.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, schema, type Db } from "@medianexus/database";
import { ParseService } from "../src/system/parse.service";

const dir = mkdtempSync(join(tmpdir(), "mn-parse-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });

let counter = 0;
function freshDb(): Db {
  const handle = createDb(join(dir, `p-${counter++}.db`));
  handle.runMigrations();
  handles.push(handle);
  return handle.db;
}
const now = () => new Date().toISOString();

function seedLibrary(db: Db): void {
  db.insert(schema.series).values({
    id: "s1", tvdbId: 7000, tmdbId: 7001, imdbId: null, title: "Show Name", overview: "",
    status: "continuing", seriesType: "standard", network: null, firstAirYear: 2020,
    monitored: true, qualityProfileId: null, rootFolderPath: "/media/tv", genres: [], images: [],
    tags: [], addedAt: now(), updatedAt: now(),
  }).run();
  db.insert(schema.movie).values({
    id: "m1", tmdbId: 100, imdbId: null, title: "Movie Name", originalTitle: null, overview: "",
    status: "released", releaseDate: null, monitored: true, qualityProfileId: null,
    rootFolderPath: "/media/movies", minimumAvailability: "released", genres: [], images: [],
    tags: [], hasFile: false, addedAt: now(), updatedAt: now(),
  }).run();
}

describe("GET /api/v1/system/parse", () => {
  it("parses a standard SxxExx episode release", async () => {
    const db = freshDb(); seedLibrary(db);
    const svc = new ParseService(db);
    const r = await svc.parse("Show.Name.S01E02.1080p.WEB-DL.x264-GROUP");
    expect(r.episodeInfo.season).toBe(1);
    expect(r.episodeInfo.episodes).toEqual([2]);
    expect(r.episodeInfo.confidence).toBe(1);
    expect(r.quality.quality.resolution).toBe("1080p");
    expect(r.quality.quality.source).toBe("webdl");
    expect(r.matchedSeriesId).toBe("s1");
  });

  it("parses a daily date-based release", async () => {
    const db = freshDb(); seedLibrary(db);
    const svc = new ParseService(db);
    const r = await svc.parse("Show.Name.2024.03.11.1080p.WEB-DL");
    expect(r.episodeInfo.dailyDate).toBe("2024-03-11");
    expect(r.episodeInfo.seriesTitle).toBe("Show Name");
    expect(r.quality.quality.resolution).toBe("1080p");
    expect(r.matchedSeriesId).toBe("s1");
  });

  it("parses a movie release (2160p UHD BluRay) and matches the library movie", async () => {
    const db = freshDb(); seedLibrary(db);
    const svc = new ParseService(db);
    const r = await svc.parse("Movie.Name.2023.2160p.UHD.BluRay.x265");
    expect(r.quality.quality.resolution).toBe("2160p");
    expect(r.quality.quality.source).toBe("bluray");
    expect(r.quality.year).toBe(2023);
    expect(r.matchedMovieId).toBe("m1");
  });

  it("surfaces languages named in the title", async () => {
    const db = freshDb();
    const svc = new ParseService(db);
    const r = await svc.parse("Show.Name.S01E02.1080p.WEB-DL.French.x264-GROUP");
    expect(r.languages).toContain("fr");
  });
});
