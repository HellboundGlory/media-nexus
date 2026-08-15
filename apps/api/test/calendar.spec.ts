// SPDX-License-Identifier: MIT
/**
 * Roadmap P3 "calendar iCal export" — the media-neutral calendar + the .ics feed.
 *
 * Covers the discovered gap fix (movies were excluded from the calendar) and the new RFC 5545
 * export:
 *  - GET /api/v1/calendar returns a discriminated union of movie releases AND episode air dates
 *    (mediaType: "movie" / "episode"), date-sorted, for a window covering both.
 *  - GET /api/v1/calendar/ical is reachable via the `?apikey=` query param (external calendar apps
 *    can't send an X-Api-Key header or a session cookie), returns a well-formed text/calendar body
 *    (BEGIN/END VCALENDAR, one all-day VEVENT per entry with SUMMARY/DTSTART, CRLF line endings),
 *    and still rejects missing/invalid keys.
 */
import { describe, beforeAll, afterAll, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/configure";
import { DB_TOKEN } from "../src/db/database.module";
import { schema } from "@medianexus/database";

const API_KEY = "cal-bootstrap-key-123";
let app: INestApplication;
let http: any;
let db: any;

const now = Date.now();
const EP_AIR = new Date(now + 2 * 86400000).toISOString(); // +2 days
const MOVIE_RELEASE = new Date(now + 3 * 86400000).toISOString().slice(0, 10); // +3 days (date-only)

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "mn-cal-"));
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = join(dir, "test.db");
  process.env.AUTO_MIGRATE = "true";
  process.env.MEDIA_NEXUS_SECRET = "test-secret-only";
  process.env.MEDIA_NEXUS_BOOTSTRAP_KEY = API_KEY;
  process.env.JOB_CONCURRENCY = "1";
  process.env.LOG_LEVEL = "warn";

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  http = app.getHttpServer();
  db = app.get(DB_TOKEN);

  const nowIso = new Date().toISOString();
  // A movie releasing inside the window.
  await db.insert(schema.movie).values({
    id: "m1", tmdbId: 1, imdbId: null, title: "Wonders", originalTitle: null, overview: "",
    status: "released", releaseDate: MOVIE_RELEASE, monitored: true, qualityProfileId: null,
    rootFolderPath: "/media/movies", minimumAvailability: "released", genres: [], images: [],
    tags: [], hasFile: false, addedAt: nowIso, updatedAt: nowIso,
  });
  // A series + season + episode airing inside the window.
  await db.insert(schema.series).values({
    id: "s1", tvdbId: 1, tmdbId: null, imdbId: null, title: "Prime Show", overview: "",
    status: "continuing", seriesType: "standard", network: null, firstAirYear: 2026,
    monitored: true, qualityProfileId: null, rootFolderPath: "/media/tv", genres: [], images: [],
    tags: [], addedAt: nowIso, updatedAt: nowIso,
  });
  await db.insert(schema.season).values({ id: "sea1", seriesId: "s1", seasonNumber: 1, monitored: true });
  await db.insert(schema.episode).values({
    id: "s1e1", seriesId: "s1", seasonId: "sea1", episodeNumber: 1, absoluteNumber: null,
    title: "Pilot", overview: "", airDateUtc: EP_AIR, monitored: true, hasFile: false,
    sceneSeasonNumber: null, sceneEpisodeNumber: null,
  });
});

afterAll(async () => {
  await app?.close();
});

describe("media-neutral /calendar (JSON)", () => {
  it("returns a movie release AND an episode air date, discriminated and sorted by date", async () => {
    const start = new Date(now - 86400000).toISOString();
    const end = new Date(now + 5 * 86400000).toISOString();
    const res = await request(http)
      .get("/api/v1/calendar")
      .query({ start, end })
      .set("X-Api-Key", API_KEY);
    expect(res.status).toBe(200);

    const entries = res.body as Array<any>;
    const movie = entries.find((e) => e.mediaType === "movie");
    const episode = entries.find((e) => e.mediaType === "episode");
    expect(movie).toMatchObject({ mediaType: "movie", movieId: "m1", movieTitle: "Wonders", releaseDate: MOVIE_RELEASE });
    expect(episode).toMatchObject({ mediaType: "episode", id: "s1e1", seriesId: "s1", seriesTitle: "Prime Show", seasonNumber: 1, episodeNumber: 1, title: "Pilot", airDateUtc: EP_AIR });

    // Sorted ascending by date: episode (+2d) before movie (+3d).
    const sorted = [...entries].sort((a, b) => {
      const da = a.mediaType === "episode" ? a.airDateUtc : a.releaseDate;
      const db = b.mediaType === "episode" ? b.airDateUtc : b.releaseDate;
      return da.localeCompare(db);
    });
    expect(JSON.stringify(entries)).toBe(JSON.stringify(sorted));
    expect(entries.map((e) => e.mediaType)).toEqual(["episode", "movie"]);
  });
});

describe("GET /api/v1/calendar/ical (RFC 5545 export)", () => {
  it("is reachable via ?apikey= and returns a well-formed VCALENDAR with one VEVENT per entry", async () => {
    const res = await request(http).get("/api/v1/calendar/ical").query({ apikey: API_KEY });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/calendar");

    const body = res.text;
    expect(body).toContain("BEGIN:VCALENDAR");
    expect(body).toContain("END:VCALENDAR");
    expect(body).toContain("VERSION:2.0");
    // CRLF line endings are required by RFC 5545 (not LF-only).
    expect(body).toContain("\r\nBEGIN:VEVENT");
    // One VEVENT per entry: the episode + the movie.
    const vevents = body.split("BEGIN:VEVENT").length - 1;
    expect(vevents).toBe(2);
    expect(body).toContain("SUMMARY:Prime Show - S01E01 - Pilot");
    expect(body).toContain(`SUMMARY:Wonders (${MOVIE_RELEASE.slice(0, 4)})`);
    expect(body).toContain(`DTSTART;VALUE=DATE:${EP_AIR.slice(0, 10).replace(/-/g, "")}`);
    expect(body).toContain(`DTSTART;VALUE=DATE:${MOVIE_RELEASE.replace(/-/g, "")}`);
  });

  it("rejects an invalid or missing key", async () => {
    expect((await request(http).get("/api/v1/calendar/ical").query({ apikey: "wrong" })).status).toBe(401);
    expect((await request(http).get("/api/v1/calendar/ical")).status).toBe(401);
  });
});
