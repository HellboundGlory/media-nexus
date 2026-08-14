// SPDX-License-Identifier: MIT
/** MediaProbeService.probeMissing — the '[]'-sentinel reconciliation loop (roadmap P2 item 6). */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, schema } from "@medianexus/database";
import type { RawFfprobeOutput } from "@medianexus/domain";
import { MediaRepository } from "../src/media/media.repository";
import { MediaProbeService } from "../src/media/media-probe.service";

const dir = mkdtempSync(join(tmpdir(), "mn-mediaprobe-"));
const filesDir = mkdtempSync(join(tmpdir(), "mn-mediaprobe-files-"));
const handle = createDb(join(dir, "t.db"));
handle.runMigrations();

const repo = new MediaRepository(handle.db);
const svc = new MediaProbeService(handle.db, repo);

const SAMPLE: RawFfprobeOutput = {
  format: { duration: "1.0" },
  streams: [{ codec_type: "video", codec_name: "h264", width: 64, height: 64 }],
};

/** Unprobed rows omit mediaInfo/languages, so the DB's NOT NULL DEFAULT '[]' applies. */
const UNPROBED = { mediaInfo: sql`'[]'`, languages: sql`'[]'` } as const;

beforeAll(() => {
  // A movie whose root folder holds a real file on disk.
  writeFileSync(join(filesDir, "Arrival.mkv"), "x");
  writeFileSync(join(filesDir, "Already.mkv"), "x");
  // "Gone.mkv" intentionally NOT written — a stale row.

  const now = new Date().toISOString();
  handle.db.insert(schema.movie).values({
    id: "m1", tmdbId: 42, imdbId: null, title: "Arrival", originalTitle: null, overview: "",
    status: "released", releaseDate: "2016-11-11", monitored: true, qualityProfileId: null,
    rootFolderPath: filesDir, minimumAvailability: "released", genres: [], images: [],
    tags: [], hasFile: true, addedAt: now, updatedAt: now,
  }).run();

  handle.db.insert(schema.mediaFile).values([
    // '[]' row whose file exists -> should be probed and populated.
    { id: "mfNull", mediaType: "movie", mediaId: "m1", episodeIds: [], relativePath: "Arrival.mkv", size: 1, quality: { source: "bluray", resolution: "2160p", edition: "" }, ...UNPROBED, dateAdded: now },
    // Already-populated row -> must NOT be touched (drops out of the '[]' set).
    { id: "mfPop", mediaType: "movie", mediaId: "m1", episodeIds: [], relativePath: "Already.mkv", size: 1, quality: { source: "web", resolution: "1080p", edition: "" }, mediaInfo: {}, languages: [], dateAdded: now },
    // '[]' row whose file is missing -> skipped (stale), left '[]'.
    { id: "mfStale", mediaType: "movie", mediaId: "m1", episodeIds: [], relativePath: "Gone.mkv", size: 1, quality: { source: "web", resolution: "1080p", edition: "" }, ...UNPROBED, dateAdded: now },
  ]).run();
});

afterAll(() => handle.close());

function readInfo(id: string) {
  return handle.db.select().from(schema.mediaFile).where(eq(schema.mediaFile.id, id)).get();
}

describe("probeMissing", () => {
  it("populates the '[]' row, leaves the populated row alone, and skips a stale file", async () => {
    const calls: string[] = [];
    svc.probe = async (p) => { calls.push(p); return SAMPLE; };

    const result = await svc.probeMissing();

    // Only the single row whose file exists was probed.
    expect(calls).toEqual([join(filesDir, "Arrival.mkv")]);

    const populated = readInfo("mfNull");
    expect(populated?.mediaInfo).toMatchObject({ videoCodec: "h264", resolution: "64x64", runtimeSeconds: 1 });
    expect(populated?.languages).toEqual([]);

    // Already-populated row untouched (still the empty blob, still out of the '[]' set).
    const untouched = readInfo("mfPop");
    expect(untouched?.mediaInfo).toEqual({});
    expect(untouched?.languages).toEqual([]);

    // Stale row left as '[]' (unprobed).
    const stale = readInfo("mfStale");
    expect(stale?.mediaInfo).toEqual([]);

    expect(result).toEqual({ probed: 1, skipped: 1, unavailable: 0 });
  });

  it("leaves a row as '[]' when the probe yields nothing, without failing the run", async () => {
    // Reset mfNull back to the '[]' placeholder so it re-enters the candidate set, then fail the probe.
    handle.db.update(schema.mediaFile).set(UNPROBED).where(eq(schema.mediaFile.id, "mfNull")).run();
    svc.probe = async () => null;

    const result = await svc.probeMissing(20);
    const row = readInfo("mfNull");
    expect(row?.mediaInfo).toEqual([]); // still unprobed, still in the retry set
    expect(result.unavailable).toBeGreaterThan(0);
  });
});
