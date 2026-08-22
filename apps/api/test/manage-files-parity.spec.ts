// SPDX-License-Identifier: MIT
/**
 * MANAGEFILES-1 regression coverage for the rebuilt Manage Files / Manage Episodes backend:
 *   - The merged `items` response: tracked surviving + stale rows and on-disk untracked files in
 *     ONE table, with quality/languages/releaseGroup/releaseType/indexerFlags/matchedFormats/
 *     rejections populated (and the below-cutoff rejection via the shared meetsCutoff()).
 *   - Per-file edit persistence through POST :id/manage-files/apply `updates`: movie column
 *     patches (quality/languages/releaseGroup/releaseType/indexerFlags) and series episode
 *     reassignment (repointing the episode.media_file_id FK coverage).
 *   - Explicit deletes: deleteFiles (tracked surviving, physical file disposed + row removed),
 *     deleteUntracked (physical file only), removeStale (row only) — the stale-delete path the
 *     merged table must keep wired to the UI.
 * Uses real scratch temp dirs on disk (no mocked fs), per project convention.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { EventBus } from "@medianexus/events";
import { qualityId } from "@medianexus/domain";
import { createDb, schema, type Db } from "@medianexus/database";
import { LibraryScanService } from "../src/library-scan/library-scan.service";
import { MediaRepository } from "../src/media/media.repository";
import { RecycleBinService } from "../src/media/recycle-bin.service";
import { ConfigService } from "../src/system/config.service";
import { EventsService } from "../src/events/events.service";
import { movieFolderName, seriesFolderName } from "../src/media/naming.helpers";

const dir = mkdtempSync(join(tmpdir(), "mn-mfparity-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });

let counter = 0;
async function harness() {
  const id = `mf-${counter++}`;
  const handle = createDb(join(dir, `${id}.db`));
  handle.runMigrations();
  handles.push(handle);
  const mediaRoot = join(dir, id, "media");
  await mkdir(mediaRoot, { recursive: true });
  const events = new EventsService(new EventBus());
  const scan = new LibraryScanService(handle.db, new MediaRepository(handle.db), events, new RecycleBinService(new ConfigService(handle.db)));
  return { db: handle.db, scan, events, mediaRoot };
}

function stageFile(path: string, size = 2048) {
  writeFile(path, Buffer.alloc(size));
}

async function seedMovie(db: Db, mediaRoot: string, over: Partial<typeof schema.movie.$inferInsert> = {}) {
  const now = new Date().toISOString();
  await db.insert(schema.movie).values({
    id: "m1", tmdbId: 1, title: "Fight Club", overview: "", status: "released", releaseDate: "1999-10-15",
    monitored: true, qualityProfileId: null, rootFolderPath: mediaRoot, minimumAvailability: "released",
    genres: [], images: [], tags: [], hasFile: true, addedAt: now, updatedAt: now, ...over,
  });
}

async function seedSeries(db: Db, mediaRoot: string) {
  const now = new Date().toISOString();
  await db.insert(schema.series).values({
    id: "s1", tvdbId: 1, tmdbId: null, imdbId: null, title: "Scan Show", overview: "",
    status: "continuing", seriesType: "standard", network: null, firstAirYear: 2020,
    monitored: true, qualityProfileId: null, rootFolderPath: mediaRoot,
    genres: [], images: [], tags: [], addedAt: now, updatedAt: now,
  });
  await db.insert(schema.season).values([{ id: "sea1", seriesId: "s1", seasonNumber: 1, monitored: true }]);
  await db.insert(schema.episode).values([
    { id: "s1e1", seriesId: "s1", seasonId: "sea1", episodeNumber: 1, absoluteNumber: null, title: "Pilot", overview: "", airDateUtc: null, monitored: true, hasFile: false, sceneSeasonNumber: null, sceneEpisodeNumber: null },
    { id: "s1e2", seriesId: "s1", seasonId: "sea1", episodeNumber: 2, absoluteNumber: null, title: "Two", overview: "", airDateUtc: null, monitored: true, hasFile: false, sceneSeasonNumber: null, sceneEpisodeNumber: null },
  ]);
}

async function seedProfile(db: Db, cutoffQualityId: number) {
  const now = new Date().toISOString();
  await db.insert(schema.qualityProfile).values({
    id: "qp1", name: "Test", items: [qualityId({ source: "bluray", resolution: "720p" }), qualityId({ source: "bluray", resolution: "1080p" }), qualityId({ source: "bluray", resolution: "2160p" })],
    cutoffQualityId, upgradeAllowed: true, isDefault: false, formatScores: {}, minFormatScore: 0, cutoffFormatScore: 0,
    createdAt: now, updatedAt: now,
  });
}

describe("MANAGEFILES-1 — merged items response", () => {
  it("movie: one table with surviving tracked, stale, and untracked rows", async () => {
    const h = await harness();
    await seedMovie(h.db, h.mediaRoot);
    const folder = join(h.mediaRoot, movieFolderName("Fight Club", "1999-10-15"));
    await mkdir(folder, { recursive: true });

    // Tracked surviving file on disk.
    const trackedRel = `${movieFolderName("Fight Club", "1999-10-15")}/Fight Club (1999).mkv`;
    stageFile(join(h.mediaRoot, trackedRel));
    await h.db.insert(schema.mediaFile).values({
      id: "mfa", mediaType: "movie", mediaId: "m1", relativePath: trackedRel, size: 100,
      quality: { source: "bluray", resolution: "1080p", edition: "" }, languages: ["English"],
      releaseGroup: "FGT", indexerFlags: 5, releaseType: null, dateAdded: new Date().toISOString(),
    });
    // Stale tracked row (no file on disk).
    const staleRel = `${movieFolderName("Fight Club", "1999-10-15")}/Gone.mkv`;
    await h.db.insert(schema.mediaFile).values({
      id: "mfb", mediaType: "movie", mediaId: "m1", relativePath: staleRel, size: 1,
      quality: { source: "web", resolution: "720p", edition: "" }, dateAdded: new Date().toISOString(),
    });
    // Untracked file on disk.
    const untrackedRel = `${movieFolderName("Fight Club", "1999-10-15")}/Fight Club (1999) 1080p BluRay.mkv`;
    stageFile(join(h.mediaRoot, untrackedRel));

    const preview = await h.scan.previewMovie("m1");
    expect(preview.stale).toEqual([{ mediaFileId: "mfb", relativePath: staleRel }]);
    expect(preview.untracked).toHaveLength(1);

    const items = preview.items;
    expect(items).toHaveLength(3);
    const tracked = items.find((r) => r.mediaFileId === "mfa")!;
    expect(tracked.stale).toBe(false);
    expect(tracked.quality).toEqual({ source: "bluray", resolution: "1080p", edition: "" });
    expect(tracked.languages).toEqual(["English"]);
    expect(tracked.releaseGroup).toBe("FGT");
    expect(tracked.indexerFlags).toBe(5);
    expect(tracked.matchedFormats).toEqual([]);

    const stale = items.find((r) => r.mediaFileId === "mfb")!;
    expect(stale.stale).toBe(true);

    const untracked = items.find((r) => !r.mediaFileId)!;
    expect(untracked.relativePath).toBe(untrackedRel);
    expect(untracked.releaseGroup).toBeNull();
    expect(untracked.indexerFlags).toBe(0);
    expect(untracked.stale).toBeUndefined();
  });

  it("series: tracked rows carry season + episodes; below-cutoff tracked rows get a rejection", async () => {
    const h = await harness();
    await seedSeries(h.db, h.mediaRoot);
    await seedProfile(h.db, qualityId({ source: "bluray", resolution: "2160p" }));
    await h.db.update(schema.series).set({ qualityProfileId: "qp1" }).where(eq(schema.series.id, "s1"));

    const seasonDir = join(h.mediaRoot, seriesFolderName("Scan Show"), "Season 1");
    await mkdir(seasonDir, { recursive: true });
    const rel = `${seriesFolderName("Scan Show")}/Season 1/Scan.Show.S01E01.1080p.WEB-DL.mkv`;
    stageFile(join(h.mediaRoot, rel));
    await h.db.insert(schema.mediaFile).values({
      id: "mfs", mediaType: "series", mediaId: "s1", relativePath: rel, size: 100,
      quality: { source: "web", resolution: "1080p", edition: "" }, releaseType: "single",
      dateAdded: new Date().toISOString(),
    });
    await h.db.update(schema.episode).set({ hasFile: true, mediaFileId: "mfs" }).where(eq(schema.episode.id, "s1e1")).run();

    const preview = await h.scan.previewSeries("s1");
    const item = preview.items.find((r) => r.mediaFileId === "mfs")!;
    expect(item.mediaFileId).toBe("mfs");
    expect(item.episodes).toEqual([
      { id: "s1e1", seasonNumber: 1, episodeNumber: 1, title: "Pilot", airDateUtc: null },
    ]);
    expect(item.seasonNumber).toBe(1);
    expect(item.releaseType).toBe("single");
    // web:1080p is below the 2160p cutoff -> below_cutoff rejection (meetsCutoff shared fn).
    expect(item.rejections.some((r) => r.reason === "below_cutoff")).toBe(true);
    expect(item.rejections[0].message).toContain("Below cutoff");
  });

  it("series: matchedFormats are populated from real custom-format definitions (not hardcoded [])", async () => {
    const h = await harness();
    await seedSeries(h.db, h.mediaRoot);
    await h.db.insert(schema.customFormat).values({
      id: "cf1", name: "1080p only", specs: [{ type: "term", term: "1080p", useRegex: false, negate: false, required: true, caseSensitive: false }],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const seasonDir = join(h.mediaRoot, seriesFolderName("Scan Show"), "Season 1");
    await mkdir(seasonDir, { recursive: true });
    const rel = `${seriesFolderName("Scan Show")}/Season 1/Scan.Show.S01E01.1080p.WEB-DL.mkv`;
    stageFile(join(h.mediaRoot, rel));
    await h.db.insert(schema.mediaFile).values({
      id: "mfs", mediaType: "series", mediaId: "s1", relativePath: rel, size: 100,
      quality: { source: "web", resolution: "1080p", edition: "" }, dateAdded: new Date().toISOString(),
    });
    await h.db.update(schema.episode).set({ hasFile: true, mediaFileId: "mfs" }).where(eq(schema.episode.id, "s1e1")).run();

    const preview = await h.scan.previewSeries("s1");
    const item = preview.items.find((r) => r.mediaFileId === "mfs")!;
    expect(item.matchedFormats).toEqual([{ id: "cf1", name: "1080p only" }]);
  });
});

describe("MANAGEFILES-1 — per-file edit persistence via apply updates", () => {
  it("movie: quality/languages/releaseGroup/releaseType/indexerFlags columns persist", async () => {
    const h = await harness();
    await seedMovie(h.db, h.mediaRoot);
    const folder = join(h.mediaRoot, movieFolderName("Fight Club", "1999-10-15"));
    await mkdir(folder, { recursive: true });
    const rel = `${movieFolderName("Fight Club", "1999-10-15")}/Fight Club (1999).mkv`;
    stageFile(join(h.mediaRoot, rel));
    await h.db.insert(schema.mediaFile).values({
      id: "mfa", mediaType: "movie", mediaId: "m1", relativePath: rel, size: 100,
      quality: { source: "web", resolution: "720p", edition: "" }, languages: [], releaseGroup: null,
      dateAdded: new Date().toISOString(),
    });

    const res = await h.scan.applyMovie("m1", {
      removeStale: [], importUntracked: [],
      updates: [{
        mediaFileId: "mfa",
        quality: { source: "bluray", resolution: "1080p", modifier: "remux", edition: "Proper" },
        languages: ["English", "French"],
        releaseGroup: "FGT",
        indexerFlags: 1 | 16,
      }],
    });
    expect(res.filesAdded).toBe(0);
    expect(res.filesRemoved).toBe(0);

    const row = (await h.db.select().from(schema.mediaFile).where(eq(schema.mediaFile.id, "mfa")))[0];
    expect(row.quality).toEqual({ source: "bluray", resolution: "1080p", edition: "Proper", modifier: "remux" });
    expect(row.languages).toEqual(["English", "French"]);
    expect(row.releaseGroup).toBe("FGT");
    expect(row.indexerFlags).toBe(17);
  });

  it("series: episode reassignment repoints the episode coverage FK", async () => {
    const h = await harness();
    await seedSeries(h.db, h.mediaRoot);
    const seasonDir = join(h.mediaRoot, seriesFolderName("Scan Show"), "Season 1");
    await mkdir(seasonDir, { recursive: true });
    const relA = `${seriesFolderName("Scan Show")}/Season 1/Scan.Show.S01E01.1080p.WEB-DL.mkv`;
    const relB = `${seriesFolderName("Scan Show")}/Season 1/Scan.Show.S01E02.1080p.WEB-DL.mkv`;
    stageFile(join(h.mediaRoot, relA));
    stageFile(join(h.mediaRoot, relB));
    await h.db.insert(schema.mediaFile).values([
      { id: "mfa", mediaType: "series", mediaId: "s1", relativePath: relA, size: 100, quality: { source: "web", resolution: "1080p", edition: "" }, dateAdded: new Date().toISOString() },
      { id: "mfb", mediaType: "series", mediaId: "s1", relativePath: relB, size: 100, quality: { source: "web", resolution: "1080p", edition: "" }, dateAdded: new Date().toISOString() },
    ]);
    await h.db.update(schema.episode).set({ hasFile: true, mediaFileId: "mfa" }).where(eq(schema.episode.id, "s1e1")).run();
    await h.db.update(schema.episode).set({ hasFile: true, mediaFileId: "mfb" }).where(eq(schema.episode.id, "s1e2")).run();

    // Reassign mfb to cover ep1 (and mfa is untouched). ep2 loses its file entirely.
    await h.scan.applySeries("s1", {
      removeStale: [], importUntracked: [],
      updates: [{ mediaFileId: "mfb", episodes: ["s1e1"] }],
    });

    const ep1 = (await h.db.select().from(schema.episode).where(eq(schema.episode.id, "s1e1")))[0];
    const ep2 = (await h.db.select().from(schema.episode).where(eq(schema.episode.id, "s1e2")))[0];
    expect(ep1.mediaFileId).toBe("mfb");
    expect(ep1.hasFile).toBe(true);
    expect(ep2.mediaFileId).toBeNull();
    expect(ep2.hasFile).toBe(false);
  });
});

describe("MANAGEFILES-1 — explicit deletes (tracked / untracked / stale)", () => {
  it("movie: deleteFiles disposes the physical file AND removes the row", async () => {
    const h = await harness();
    await seedMovie(h.db, h.mediaRoot);
    const folder = join(h.mediaRoot, movieFolderName("Fight Club", "1999-10-15"));
    await mkdir(folder, { recursive: true });
    const rel = `${movieFolderName("Fight Club", "1999-10-15")}/Fight Club (1999).mkv`;
    const abs = join(h.mediaRoot, rel);
    stageFile(abs);
    await h.db.insert(schema.mediaFile).values({
      id: "mfa", mediaType: "movie", mediaId: "m1", relativePath: rel, size: 100,
      quality: { source: "bluray", resolution: "1080p", edition: "" }, dateAdded: new Date().toISOString(),
    });

    const res = await h.scan.applyMovie("m1", { removeStale: [], importUntracked: [], deleteFiles: ["mfa"] });
    expect(res.filesRemoved).toBe(1);
    expect(existsSync(abs)).toBe(false);
    expect(await h.db.select().from(schema.mediaFile).where(eq(schema.mediaFile.id, "mfa"))).toHaveLength(0);
  });

  it("movie: deleteUntracked disposes the physical file only (no DB row existed)", async () => {
    const h = await harness();
    await seedMovie(h.db, h.mediaRoot);
    const folder = join(h.mediaRoot, movieFolderName("Fight Club", "1999-10-15"));
    await mkdir(folder, { recursive: true });
    const untrackedRel = `${movieFolderName("Fight Club", "1999-10-15")}/Fight Club (1999) 1080p BluRay.mkv`;
    const abs = join(h.mediaRoot, untrackedRel);
    stageFile(abs);

    const res = await h.scan.applyMovie("m1", { removeStale: [], importUntracked: [], deleteUntracked: [untrackedRel] });
    expect(res.filesRemoved).toBe(1);
    expect(existsSync(abs)).toBe(false);
  });

  it("series: removeStale keeps working (row removed, episode unpointed) — the stale-delete path the UI stays wired to", async () => {
    const h = await harness();
    await seedSeries(h.db, h.mediaRoot);
    const staleRel = `${seriesFolderName("Scan Show")}/Season 1/Scan.Show.S01E01.1080p.WEB-DL.mkv`;
    await h.db.insert(schema.mediaFile).values({
      id: "mfs_stale", mediaType: "series", mediaId: "s1", relativePath: staleRel, size: 1,
      quality: { source: "web", resolution: "1080p", edition: "" }, dateAdded: new Date().toISOString(),
    });
    await h.db.update(schema.episode).set({ hasFile: true, mediaFileId: "mfs_stale" }).where(eq(schema.episode.id, "s1e1")).run();

    await h.scan.applySeries("s1", { removeStale: ["mfs_stale"], importUntracked: [] });
    expect(await h.db.select().from(schema.mediaFile).where(eq(schema.mediaFile.id, "mfs_stale"))).toHaveLength(0);
    const ep = (await h.db.select().from(schema.episode).where(eq(schema.episode.id, "s1e1")))[0];
    expect(ep.hasFile).toBe(false);
    expect(ep.mediaFileId).toBeNull();
  });
});