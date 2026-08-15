// SPDX-License-Identifier: MIT
/**
 * Roadmap P3, gap report J3 — media_file.episode_ids hot-path fix.
 *
 * Two concerns:
 *  1. MediaRepository.existingFiles()'s series branch now answers "which of this series' files
 *     cover these wanted episode ids" through the indexed `episode.media_file_id` FK join instead
 *     of loading every media_file row and filtering its `episode_ids` JSON in JS. Proves a
 *     season-pack file covering several episodes is returned (and deduped) for a subset target.
 *  2. The startup backfill (runEpisodeMediaFileBackfill) populates `episode.media_file_id` from
 *     pre-existing `media_file.episode_ids` for rows written before the FK existed, is idempotent
 *     (re-run is a no-op), and never overwrites an already-set pointer (isNull guard).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@medianexus/database";
import { episodeTarget, type EpisodeRef } from "@medianexus/domain";
import { MediaRepository } from "../src/media/media.repository";
import { runEpisodeMediaFileBackfill } from "../src/media/media-file-backfill";
import type { Db } from "@medianexus/database";

const now = new Date().toISOString();

function epRef(id: string): EpisodeRef {
  return { id, seasonNumber: 1, episodeNumber: 0, title: "", monitored: true, hasFile: false };
}

async function seedSeries(db: Db, seriesId: string, seasonId: string) {
  await db.insert(schema.series).values({
    id: seriesId, tvdbId: null, tmdbId: null, imdbId: null, title: "Show", overview: "",
    status: "continuing", seriesType: "standard", network: null, firstAirYear: 2020,
    monitored: true, qualityProfileId: null, rootFolderPath: "/media/tv", genres: [], images: [],
    tags: [], addedAt: now, updatedAt: now,
  });
  await db.insert(schema.season).values({ id: seasonId, seriesId, seasonNumber: 1, monitored: true, qualityProfileId: null });
}

describe("existingFiles() series branch (J3 hot-path join)", () => {
  let handle: ReturnType<typeof createDb>;
  let repo: MediaRepository;

  beforeAll(async () => {
    handle = createDb(join(mkdtempSync(join(tmpdir(), "mn-j3-files-")), "t.db"));
    await handle.runMigrations();
    repo = new MediaRepository(handle.db);
    const db = handle.db;

    await seedSeries(db, "s1", "sea1");
    await db.insert(schema.episode).values([
      { id: "e1", seriesId: "s1", seasonId: "sea1", episodeNumber: 1, absoluteNumber: null, title: "", overview: "", airDateUtc: null, monitored: true, hasFile: false, sceneSeasonNumber: null, sceneEpisodeNumber: null },
      { id: "e2", seriesId: "s1", seasonId: "sea1", episodeNumber: 2, absoluteNumber: null, title: "", overview: "", airDateUtc: null, monitored: true, hasFile: false, sceneSeasonNumber: null, sceneEpisodeNumber: null },
      { id: "e3", seriesId: "s1", seasonId: "sea1", episodeNumber: 3, absoluteNumber: null, title: "", overview: "", airDateUtc: null, monitored: true, hasFile: false, sceneSeasonNumber: null, sceneEpisodeNumber: null },
      { id: "e4", seriesId: "s1", seasonId: "sea1", episodeNumber: 4, absoluteNumber: null, title: "", overview: "", airDateUtc: null, monitored: true, hasFile: false, sceneSeasonNumber: null, sceneEpisodeNumber: null },
    ]);
    // A season-pack file covering three episodes + a single-episode file (sources for the join).
    await db.insert(schema.mediaFile).values([
      { id: "mf_pack", mediaType: "series", mediaId: "s1", episodeIds: ["e1", "e2", "e3"], relativePath: "Show/Season 1/Season 1.mkv", size: 100, quality: { source: "web", resolution: "1080p", edition: "" }, mediaInfo: {}, languages: [], dateAdded: now },
      { id: "mf_single", mediaType: "series", mediaId: "s1", episodeIds: ["e4"], relativePath: "Show/Season 1/S01E04.mkv", size: 50, quality: { source: "web", resolution: "720p", edition: "" }, mediaInfo: {}, languages: [], dateAdded: now },
    ]);
    // Sync the FK inverse for the fixture — exactly what the write sites / backfill maintain.
    for (const ep of ["e1", "e2", "e3"]) await db.update(schema.episode).set({ mediaFileId: "mf_pack" }).where(eq(schema.episode.id, ep));
    await db.update(schema.episode).set({ mediaFileId: "mf_single" }).where(eq(schema.episode.id, "e4"));
  });

  afterAll(() => handle.close());

  it("returns a season-pack file via the FK join for a subset of its episodes", async () => {
    const files = await repo.existingFiles(episodeTarget("s1", 1, [epRef("e1")], false));
    expect(files.map((f) => f.id)).toEqual(["mf_pack"]);
  });

  it("returns the file (deduped) when the wanted set includes several covered episodes", async () => {
    const files = await repo.existingFiles(episodeTarget("s1", 1, [epRef("e1"), epRef("e3")], false));
    expect(files).toHaveLength(1);
    expect(files[0].id).toBe("mf_pack");
  });

  it("routes through the FK: an episode with its own file returns that file, not a same-series one", async () => {
    const files = await repo.existingFiles(episodeTarget("s1", 1, [epRef("e4")], false));
    expect(files.map((f) => f.id)).toEqual(["mf_single"]);
  });

  it("returns [] for an empty wanted set (no crash on an empty IN list)", async () => {
    expect(await repo.existingFiles(episodeTarget("s1", 1, [], true))).toEqual([]);
  });
});

describe("episode.mediaFileId backfill (J3)", () => {
  let handle: ReturnType<typeof createDb>;

  beforeAll(async () => {
    handle = createDb(join(mkdtempSync(join(tmpdir(), "mn-j3-backfill-")), "t.db"));
    await handle.runMigrations();
    const db = handle.db;
    await seedSeries(db, "sb", "seab");
    // A media_file whose episode_ids names b1,b2,b3 (the FK was never set — pre-feature state),
    // plus a separate file that b3 already points at (to prove the guard never overwrites).
    await db.insert(schema.mediaFile).values([
      { id: "mf_b", mediaType: "series", mediaId: "sb", episodeIds: ["b1", "b2", "b3"], relativePath: "Show/Season 1/S01.mkv", size: 0, quality: { source: "web", resolution: "1080p", edition: "" }, mediaInfo: {}, languages: [], dateAdded: now },
      { id: "mf_other", mediaType: "series", mediaId: "sb", episodeIds: ["b3"], relativePath: "Show/Season 1/S01E03.mkv", size: 1, quality: { source: "web", resolution: "720p", edition: "" }, mediaInfo: {}, languages: [], dateAdded: now },
    ]);
    await db.insert(schema.episode).values([
      // b1, b2 = pre-FK rows (media_file_id NULL). b3 already points at the other file.
      { id: "b1", seriesId: "sb", seasonId: "seab", episodeNumber: 1, absoluteNumber: null, title: "", overview: "", airDateUtc: null, monitored: true, hasFile: false, sceneSeasonNumber: null, sceneEpisodeNumber: null },
      { id: "b2", seriesId: "sb", seasonId: "seab", episodeNumber: 2, absoluteNumber: null, title: "", overview: "", airDateUtc: null, monitored: true, hasFile: false, sceneSeasonNumber: null, sceneEpisodeNumber: null },
      { id: "b3", seriesId: "sb", seasonId: "seab", episodeNumber: 3, absoluteNumber: null, title: "", overview: "", airDateUtc: null, monitored: true, hasFile: false, mediaFileId: "mf_other", sceneSeasonNumber: null, sceneEpisodeNumber: null },
    ]);
  });

  afterAll(() => handle.close());

  it("populates mediaFileId for episodes the JSON array names, leaving already-set rows alone", async () => {
    const r1 = await runEpisodeMediaFileBackfill(handle.db);
    expect(r1.linked).toBe(2); // b1 + b2 got set; b3 already pointed at mf_other

    const rows = await handle.db.select({ id: schema.episode.id, mediaFileId: schema.episode.mediaFileId }).from(schema.episode);
    const byId = new Map(rows.map((r) => [r.id, r.mediaFileId]));
    expect(byId.get("b1")).toBe("mf_b");
    expect(byId.get("b2")).toBe("mf_b");
    expect(byId.get("b3")).toBe("mf_other"); // never overwritten
  });

  it("is idempotent: a second run no-ops without erroring or double-applying", async () => {
    const r2 = await runEpisodeMediaFileBackfill(handle.db);
    expect(r2.linked).toBe(0);
    const rows = await handle.db.select({ id: schema.episode.id, mediaFileId: schema.episode.mediaFileId }).from(schema.episode);
    const byId = new Map(rows.map((r) => [r.id, r.mediaFileId]));
    expect(byId.get("b1")).toBe("mf_b");
    expect(byId.get("b2")).toBe("mf_b");
    expect(byId.get("b3")).toBe("mf_other");
  });
});
