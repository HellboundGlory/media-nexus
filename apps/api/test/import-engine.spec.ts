// SPDX-License-Identifier: MIT
/**
 * Roadmap P0.5 (gap report B2): import used to pick the single largest video file under a
 * completed download and move it — a season pack with N episode files imported 1 and lost
 * the other N-1. This covers the multi-file replacement: every video file is enumerated and
 * decided independently (sample/incomplete-transfer detection, episode matching,
 * upgrade-vs-existing-file), and approved files replace (not duplicate) a superseded one.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, and } from "drizzle-orm";
import { EventBus } from "@medianexus/events";
import { createDb, schema } from "@medianexus/database";
import { qualityId } from "@medianexus/domain";
import type { ClientQueueItem, DownloadClientContract, HealthResult, AddDownloadInput } from "@medianexus/integrations";
import { AcquisitionService } from "../src/acquisition/acquisition.service";
import { MediaRepository } from "../src/media/media.repository";
import { ConfigService } from "../src/system/config.service";
import { EventsService } from "../src/events/events.service";
import { BlocklistService } from "../src/blocklist/blocklist.service";
import { RootFoldersService } from "../src/root-folders/root-folders.service";
import { RemotePathMappingsService } from "../src/remote-path-mappings/remote-path-mappings.service";
import { RecycleBinService } from "../src/media/recycle-bin.service";
import type { ProvidersService, ConfiguredClient } from "../src/providers/demo.providers";
import { ProviderStatusService } from "../src/providers/provider-status.service";

const dir = mkdtempSync(join(tmpdir(), "mn-import-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });

class StubClient implements DownloadClientContract {
  readonly key = "stub";
  readonly kind = "torrent" as const;
  items: ClientQueueItem[] = [];
  async addRelease(_input: AddDownloadInput): Promise<{ downloadId: string }> { return { downloadId: "d1" }; }
  async getQueue(): Promise<ClientQueueItem[]> { return this.items; }
  async remove(): Promise<void> {}
  async healthcheck(): Promise<HealthResult> { return { ok: true }; }
}

interface Harness {
  db: ReturnType<typeof createDb>["db"];
  service: AcquisitionService;
  client: StubClient;
  configured: ConfiguredClient;
  downloadsRoot: string;
  mediaRoot: string;
  config: ConfigService;
}

let counter = 0;
async function harness(): Promise<Harness> {
  const id = `imp-${counter++}`;
  const handle = createDb(join(dir, `${id}.db`));
  handle.runMigrations();
  handles.push(handle);

  const downloadsRoot = join(dir, id, "downloads");
  const mediaRoot = join(dir, id, "media");
  mkdirSync(downloadsRoot, { recursive: true });
  mkdirSync(mediaRoot, { recursive: true });

  const config = new ConfigService(handle.db);
  await config.upsert({ "paths.downloads": downloadsRoot });
  const rootFolders = new RootFoldersService(handle.db, new ConfigService(handle.db));
  await rootFolders.create({ path: mediaRoot, name: "", isDefaultMovie: true, isDefaultSeries: true });

  const events = new EventsService(new EventBus());
  const client = new StubClient();
  const providers = { configuredDownloadClients: async () => [{ row: null, provider: client }] } as unknown as ProvidersService;
  const blocklist = new BlocklistService(handle.db);
  const service = new AcquisitionService(
    handle.db, config, events, providers, new MediaRepository(handle.db), blocklist,
    rootFolders, new RemotePathMappingsService(handle.db), new RecycleBinService(config), new ProviderStatusService(handle.db, config),
  );
  return { db: handle.db, service, client, configured: { row: null, provider: client }, downloadsRoot, mediaRoot, config };
}

/** Stage a multi-file pack directory the way a torrent client would deliver one. */
function stagePack(downloadsRoot: string, folder: string, files: { name: string; size?: number }[]): string {
  const dirPath = join(downloadsRoot, folder);
  mkdirSync(dirPath, { recursive: true });
  for (const f of files) {
    const full = join(dirPath, f.name);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, Buffer.alloc(f.size ?? 2048));
  }
  return dirPath;
}

async function seedSeries(db: Harness["db"], mediaRoot: string, qualityProfileId: string | null = null) {
  const now = new Date().toISOString();
  await db.insert(schema.series).values({
    id: "s1", tvdbId: 1, tmdbId: null, imdbId: null, title: "Pack Show", overview: "",
    status: "continuing", seriesType: "standard", network: null, firstAirYear: 2020,
    monitored: true, qualityProfileId, rootFolderPath: mediaRoot,
    genres: [], images: [], tags: [], addedAt: now, updatedAt: now,
  });
  await db.insert(schema.season).values([{ id: "sea2", seriesId: "s1", seasonNumber: 2, monitored: true }]);
  await db.insert(schema.episode).values([
    { id: "s2e1", seriesId: "s1", seasonId: "sea2", episodeNumber: 1, absoluteNumber: null, title: "", overview: "", airDateUtc: null, monitored: true, hasFile: false, sceneSeasonNumber: null, sceneEpisodeNumber: null },
    { id: "s2e2", seriesId: "s1", seasonId: "sea2", episodeNumber: 2, absoluteNumber: null, title: "", overview: "", airDateUtc: null, monitored: true, hasFile: false, sceneSeasonNumber: null, sceneEpisodeNumber: null },
    { id: "s2e3", seriesId: "s1", seasonId: "sea2", episodeNumber: 3, absoluteNumber: null, title: "", overview: "", airDateUtc: null, monitored: true, hasFile: false, sceneSeasonNumber: null, sceneEpisodeNumber: null },
  ]);
}

async function seedProfile(db: Harness["db"], id: string, items: number[], cutoffQualityId: number) {
  const now = new Date().toISOString();
  await db.insert(schema.qualityProfile).values({ id, name: id, items, cutoffQualityId, upgradeAllowed: true, language: "en", isDefault: false, createdAt: now, updatedAt: now });
}

async function packQueueEntry(db: Harness["db"], title: string, quality: { source: string; resolution: string; edition: string }) {
  const now = new Date().toISOString();
  const row = {
    id: "q1", mediaType: "series", mediaId: "s1", downloadClientId: null, downloadId: "d1",
    title, status: "downloading", progress: 50, size: 6144, remainingTime: null, errorMessage: null,
    data: { releaseTitle: title, quality } as Record<string, unknown>,
    addedAt: now, updatedAt: now,
  };
  await db.insert(schema.downloadQueueEntry).values(row);
  return row;
}

const completedPack = (contentPath: string): ClientQueueItem => ({
  downloadId: "d1", title: "Pack.Show.S02.1080p.WEB-DL", status: "completed", progress: 100, size: 6144, contentPath,
});

describe("P0.5 — season pack imports every episode file", () => {
  let h: Harness;
  beforeEach(async () => { h = await harness(); await seedSeries(h.db, h.mediaRoot); });

  it("imports all N episode files, not just the largest", async () => {
    const packDir = stagePack(h.downloadsRoot, "Pack.Show.S02.1080p.WEB-DL", [
      { name: "Pack.Show.S02E01.1080p.WEB-DL.mkv", size: 1000 },
      { name: "Pack.Show.S02E02.1080p.WEB-DL.mkv", size: 5000 }, // largest — the old single-file bug would only import this one
      { name: "Pack.Show.S02E03.1080p.WEB-DL.mkv", size: 2000 },
    ]);
    await packQueueEntry(h.db, "Pack.Show.S02.1080p.WEB-DL", { source: "web", resolution: "1080p", edition: "" });
    h.client.items = [completedPack(packDir)];

    const result = await h.service.syncForClient(h.configured);
    expect(result.imported).toBe(1); // one queue entry, regardless of how many files it contained

    const files = await h.db.select().from(schema.mediaFile).where(eq(schema.mediaFile.mediaType, "series"));
    expect(files).toHaveLength(3);

    const episodes = await h.db.select().from(schema.episode).where(eq(schema.episode.seriesId, "s1"));
    expect(episodes.every((e) => e.hasFile)).toBe(true);

    const entry = (await h.db.select().from(schema.downloadQueueEntry).where(eq(schema.downloadQueueEntry.id, "q1")))[0];
    expect(entry.status).toBe("imported");
  });

  it("rejects a sample file inside the pack — it is not imported, and stays visible in history", async () => {
    const packDir = stagePack(h.downloadsRoot, "Pack.Show.S02.1080p.WEB-DL", [
      { name: "Pack.Show.S02E01.1080p.WEB-DL.mkv", size: 2000 },
      { name: "Pack.Show.S02E01.Sample.mkv", size: 100 },
      { name: "Pack.Show.S02E02.1080p.WEB-DL.mkv", size: 2000 },
    ]);
    await packQueueEntry(h.db, "Pack.Show.S02.1080p.WEB-DL", { source: "web", resolution: "1080p", edition: "" });
    h.client.items = [completedPack(packDir)];

    await h.service.syncForClient(h.configured);

    const files = await h.db.select().from(schema.mediaFile);
    expect(files).toHaveLength(2); // sample excluded
    expect(files.some((f) => f.relativePath.toLowerCase().includes("sample"))).toBe(false);

    const history = await h.db.select().from(schema.historyEntry).where(eq(schema.historyEntry.action, "import_completed"));
    const rejected = (history[0].data as { rejected?: { path: string; reasons: string[] }[] }).rejected ?? [];
    expect(rejected.some((r) => r.path.includes("Sample") && r.reasons.includes("sample"))).toBe(true);
  });

  it("rejects an empty/incomplete file inside the pack", async () => {
    const packDir = stagePack(h.downloadsRoot, "Pack.Show.S02.1080p.WEB-DL", [
      { name: "Pack.Show.S02E01.1080p.WEB-DL.mkv", size: 2000 },
      { name: "Pack.Show.S02E02.1080p.WEB-DL.mkv", size: 0 }, // still being written
    ]);
    await packQueueEntry(h.db, "Pack.Show.S02.1080p.WEB-DL", { source: "web", resolution: "1080p", edition: "" });
    h.client.items = [completedPack(packDir)];

    await h.service.syncForClient(h.configured);

    const ep1 = (await h.db.select().from(schema.episode).where(eq(schema.episode.id, "s2e1")))[0];
    const ep2 = (await h.db.select().from(schema.episode).where(eq(schema.episode.id, "s2e2")))[0];
    expect(ep1.hasFile).toBe(true);
    expect(ep2.hasFile).toBe(false); // the empty file was rejected, not imported as a 0-byte "episode"
  });

  it("rejects a file whose episode number doesn't belong to the target season", async () => {
    const packDir = stagePack(h.downloadsRoot, "Pack.Show.S02.1080p.WEB-DL", [
      { name: "Pack.Show.S02E01.1080p.WEB-DL.mkv", size: 2000 },
      { name: "Pack.Show.S02E99.1080p.WEB-DL.mkv", size: 2000 }, // no episode 99 in this season
    ]);
    await packQueueEntry(h.db, "Pack.Show.S02.1080p.WEB-DL", { source: "web", resolution: "1080p", edition: "" });
    h.client.items = [completedPack(packDir)];

    await h.service.syncForClient(h.configured);
    const files = await h.db.select().from(schema.mediaFile);
    expect(files).toHaveLength(1);
  });
});

describe("P0.5 — upgrade-replace", () => {
  let h: Harness;

  it("replaces the existing file when the release is a genuine upgrade", async () => {
    h = await harness();
    await seedProfile(h.db, "qp1", [
      qualityId({ source: "hdtv", resolution: "720p", edition: "" } as never),
      qualityId({ source: "web", resolution: "1080p", edition: "" } as never),
    ], qualityId({ source: "web", resolution: "1080p", edition: "" } as never));
    await seedSeries(h.db, h.mediaRoot, "qp1");

    // Pre-existing lower-quality file for episode 1.
    const now = new Date().toISOString();
    await h.db.insert(schema.mediaFile).values({
      id: "mf_old", mediaType: "series", mediaId: "s1", episodeIds: ["s2e1"],
      relativePath: "Pack Show/Season 2/old.mkv", size: 500,
      quality: { source: "hdtv", resolution: "720p", edition: "" }, dateAdded: now,
    });
    mkdirSync(join(h.mediaRoot, "Pack Show", "Season 2"), { recursive: true });
    writeFileSync(join(h.mediaRoot, "Pack Show", "Season 2", "old.mkv"), Buffer.alloc(500));
    await h.db.update(schema.episode).set({ hasFile: true, mediaFileId: "mf_old" }).where(eq(schema.episode.id, "s2e1"));

    const packDir = stagePack(h.downloadsRoot, "Pack.Show.S02E01.1080p.WEB-DL", [{ name: "Pack.Show.S02E01.1080p.WEB-DL.mkv", size: 2000 }]);
    await packQueueEntry(h.db, "Pack.Show.S02E01.1080p.WEB-DL", { source: "web", resolution: "1080p", edition: "" });
    h.client.items = [{ downloadId: "d1", title: "Pack.Show.S02E01.1080p.WEB-DL", status: "completed", progress: 100, size: 2000, contentPath: packDir }];

    await h.service.syncForClient(h.configured);

    const files = await h.db.select().from(schema.mediaFile).where(and(eq(schema.mediaFile.mediaType, "series"), eq(schema.mediaFile.mediaId, "s1")));
    expect(files).toHaveLength(1); // old row replaced, not duplicated
    expect(files[0].quality).toEqual({ source: "web", resolution: "1080p", edition: "" });
  });

  it("rejects (does not import) once the existing file already meets the profile's cutoff", async () => {
    h = await harness();
    await seedProfile(h.db, "qp1", [
      qualityId({ source: "hdtv", resolution: "720p", edition: "" } as never),
      qualityId({ source: "web", resolution: "1080p", edition: "" } as never),
    ], qualityId({ source: "hdtv", resolution: "720p", edition: "" } as never)); // cutoff already at the lowest allowed
    await seedSeries(h.db, h.mediaRoot, "qp1");

    const now = new Date().toISOString();
    await h.db.insert(schema.mediaFile).values({
      id: "mf_old", mediaType: "series", mediaId: "s1", episodeIds: ["s2e1"],
      relativePath: "Pack Show/Season 2/old.mkv", size: 500,
      quality: { source: "hdtv", resolution: "720p", edition: "" }, dateAdded: now,
    });
    await h.db.update(schema.episode).set({ hasFile: true, mediaFileId: "mf_old" }).where(eq(schema.episode.id, "s2e1"));

    const packDir = stagePack(h.downloadsRoot, "Pack.Show.S02E01.1080p.WEB-DL", [{ name: "Pack.Show.S02E01.1080p.WEB-DL.mkv", size: 2000 }]);
    await packQueueEntry(h.db, "Pack.Show.S02E01.1080p.WEB-DL", { source: "web", resolution: "1080p", edition: "" });
    h.client.items = [{ downloadId: "d1", title: "Pack.Show.S02E01.1080p.WEB-DL", status: "completed", progress: 100, size: 2000, contentPath: packDir }];

    // No importable file -> throws -> recordImportFailure, exactly like "no video found".
    await h.service.syncForClient(h.configured);

    const entry = (await h.db.select().from(schema.downloadQueueEntry).where(eq(schema.downloadQueueEntry.id, "q1")))[0];
    expect(entry.errorMessage).toMatch(/cutoff_already_met/);
    const files = await h.db.select().from(schema.mediaFile).where(eq(schema.mediaFile.mediaId, "s1"));
    expect(files).toHaveLength(1); // still just the old one — nothing replaced it
  });
});

async function seedMovie(db: Harness["db"], mediaRoot: string) {
  const now = new Date().toISOString();
  await db.insert(schema.movie).values({
    id: "m1", tmdbId: 1, title: "Mission: Impossible", overview: "", status: "released", releaseDate: "1996-05-22",
    monitored: true, qualityProfileId: null, rootFolderPath: mediaRoot, minimumAvailability: "announced",
    genres: [], images: [], tags: [], hasFile: false, addedAt: now, updatedAt: now,
  });
}

async function movieQueueEntry(db: Harness["db"], title: string, quality: { source: string; resolution: string; edition: string }) {
  const now = new Date().toISOString();
  const row = {
    id: "q1", mediaType: "movie", mediaId: "m1", downloadClientId: null, downloadId: "d1",
    title, status: "downloading", progress: 50, size: 2048, remainingTime: null, errorMessage: null,
    data: { releaseTitle: title, quality } as Record<string, unknown>,
    addedAt: now, updatedAt: now,
  };
  await db.insert(schema.downloadQueueEntry).values(row);
  return row;
}

describe("B7 — naming templates honored on import", () => {
  it("builds the movie filename from the configured media.naming template, sanitizing the title", async () => {
    const h = await harness();
    await h.config.upsert({ "media.naming": { movies: "{Quality Full} - {Movie Title} ({Release Year})", episodes: "{Series Title} - S{season:00}E{episode:00} - {Episode Title}" } });
    await seedMovie(h.db, h.mediaRoot);
    const downloadDir = stagePack(h.downloadsRoot, "Mission.Impossible.1996.1080p.BluRay", [{ name: "movie.mkv", size: 4096 }]);
    await movieQueueEntry(h.db, "Mission.Impossible.1996.1080p.BluRay", { source: "bluray", resolution: "1080p", edition: "" });
    h.client.items = [{ downloadId: "d1", title: "Mission.Impossible.1996.1080p.BluRay", status: "completed", progress: 100, size: 4096, contentPath: downloadDir }];

    await h.service.syncForClient(h.configured);

    const files = await h.db.select().from(schema.mediaFile).where(eq(schema.mediaFile.mediaType, "movie"));
    expect(files).toHaveLength(1);
    // ":" is illegal in a filename — the title is sanitized, not passed through raw.
    expect(files[0].relativePath).toContain("Bluray 1080p - Mission Impossible (1996).mkv");
  });

  it("formats a multi-episode file in Range style (S01E01-02) via the configured template", async () => {
    const h = await harness();
    await h.config.upsert({ "media.naming": { movies: "{Movie Title} ({Release Year})", episodes: "{Series Title} - S{season:00}E{episode:00} - {Episode Title}" } });
    await seedSeries(h.db, h.mediaRoot);
    await h.db.update(schema.episode).set({ title: "Part One" }).where(eq(schema.episode.id, "s2e1"));
    await h.db.update(schema.episode).set({ title: "Part Two" }).where(eq(schema.episode.id, "s2e2"));

    const downloadDir = stagePack(h.downloadsRoot, "Pack.Show.S02E01E02.1080p.WEB-DL", [{ name: "multi.mkv", size: 3000 }]);
    await packQueueEntry(h.db, "Pack.Show.S02E01E02.1080p.WEB-DL", { source: "web", resolution: "1080p", edition: "" });
    h.client.items = [{ downloadId: "d1", title: "Pack.Show.S02E01E02.1080p.WEB-DL", status: "completed", progress: 100, size: 3000, contentPath: downloadDir }];

    await h.service.syncForClient(h.configured);

    const files = await h.db.select().from(schema.mediaFile).where(eq(schema.mediaFile.mediaType, "series"));
    expect(files).toHaveLength(1);
    expect(files[0].relativePath).toContain("Pack Show - S02E01-02 - Part One + Part Two.mkv");
    // Coverage is carried by the episode -> media_file FK (roadmap J3), not a JSON column.
    const linked = await h.db.select({ id: schema.episode.id }).from(schema.episode).where(eq(schema.episode.mediaFileId, files[0].id));
    expect(linked.map((l) => l.id).sort()).toEqual(["s2e1", "s2e2"]);
  });
});

describe("D8 — daily/anime release import (not Season Unknown)", () => {
  async function seedSeriesTypeSeries(
    db: Harness["db"],
    mediaRoot: string,
    over: { id: string; seriesType: string; title: string; seasons: { id: string; number: number; episodes: { id: string; number: number; absoluteNumber?: number | null; airDateUtc?: string | null }[] }[] },
  ) {
    const now = new Date().toISOString();
    await db.insert(schema.series).values({
      id: over.id, tvdbId: 1, tmdbId: null, imdbId: null, title: over.title, overview: "",
      status: "continuing", seriesType: over.seriesType, network: null, firstAirYear: 2023,
      monitored: true, qualityProfileId: null, rootFolderPath: mediaRoot,
      genres: [], images: [], tags: [], addedAt: now, updatedAt: now,
    });
    for (const s of over.seasons) {
      await db.insert(schema.season).values({ id: s.id, seriesId: over.id, seasonNumber: s.number, monitored: true });
      await db.insert(schema.episode).values(
        s.episodes.map((e) => ({
          id: e.id, seriesId: over.id, seasonId: s.id, episodeNumber: e.number,
          absoluteNumber: e.absoluteNumber ?? null, title: "", overview: "",
          airDateUtc: e.airDateUtc ?? null, monitored: true, hasFile: false,
          sceneSeasonNumber: null, sceneEpisodeNumber: null,
        })),
      );
    }
  }

  async function singleFileEntry(h: Harness, mediaId: string, title: string) {
    const now = new Date().toISOString();
    await h.db.insert(schema.downloadQueueEntry).values({
      id: "q1", mediaType: "series", mediaId, downloadClientId: null, downloadId: "d1",
      title, status: "downloading", progress: 50, size: 2000, remainingTime: null, errorMessage: null,
      data: { releaseTitle: title, quality: { source: "web", resolution: "1080p", edition: "" } } as Record<string, unknown>,
      addedAt: now, updatedAt: now,
    });
  }

  it("imports a daily-dated release onto its episode instead of Season Unknown", async () => {
    const h = await harness();
    await seedSeriesTypeSeries(h.db, h.mediaRoot, {
      id: "sd", seriesType: "daily", title: "Daily Chat",
      seasons: [{
        id: "sdsea1", number: 1,
        episodes: [
          { id: "sde1", number: 1, airDateUtc: "2024-05-14T00:00:00.000Z" },
          { id: "sde2", number: 2, airDateUtc: "2024-05-15T00:00:00.000Z" },
        ],
      }],
    });
    const title = "Daily.Chat.2024.05.15.1080p.HDTV";
    const downloadDir = stagePack(h.downloadsRoot, title, [{ name: `${title}.mkv`, size: 2000 }]);
    await singleFileEntry(h, "sd", title);
    h.client.items = [{ downloadId: "d1", title, status: "completed", progress: 100, size: 2000, contentPath: downloadDir }];

    await h.service.syncForClient(h.configured);

    const ep2 = (await h.db.select().from(schema.episode).where(eq(schema.episode.id, "sde2")))[0];
    const ep1 = (await h.db.select().from(schema.episode).where(eq(schema.episode.id, "sde1")))[0];
    expect(ep2.hasFile).toBe(true);
    expect(ep1.hasFile).toBe(false);
    const files = await h.db.select().from(schema.mediaFile).where(eq(schema.mediaFile.mediaId, "sd"));
    expect(files).toHaveLength(1);
    expect(files[0].relativePath).toContain("Season 1"); // not Season Unknown
  });

  it("imports an anime-absolute release onto its episode across seasons", async () => {
    const h = await harness();
    await seedSeriesTypeSeries(h.db, h.mediaRoot, {
      id: "sa", seriesType: "anime", title: "Anime Show",
      seasons: [
        { id: "sasea1", number: 1, episodes: [{ id: "sa1e1", number: 1, absoluteNumber: 1 }, { id: "sa1e12", number: 12, absoluteNumber: 12 }] },
        { id: "sasea2", number: 2, episodes: [{ id: "sa2e1", number: 1, absoluteNumber: 13 }] },
      ],
    });
    const title = "[Subs] Anime.Show - 13 [1080p]";
    const downloadDir = stagePack(h.downloadsRoot, title, [{ name: `${title}.mkv`, size: 2000 }]);
    await singleFileEntry(h, "sa", title);
    h.client.items = [{ downloadId: "d1", title, status: "completed", progress: 100, size: 2000, contentPath: downloadDir }];

    await h.service.syncForClient(h.configured);

    const target = (await h.db.select().from(schema.episode).where(eq(schema.episode.id, "sa2e1")))[0];
    expect(target.hasFile).toBe(true);
    const files = await h.db.select().from(schema.mediaFile).where(eq(schema.mediaFile.mediaId, "sa"));
    expect(files).toHaveLength(1);
    // The episode -> media_file FK is the coverage source (roadmap J3).
    const linked = await h.db.select({ id: schema.episode.id }).from(schema.episode).where(eq(schema.episode.mediaFileId, files[0].id));
    expect(linked.map((l) => l.id)).toEqual(["sa2e1"]);
    expect(files[0].relativePath).toContain("Season 2");
  });
});

describe("B7 — recycle bin", () => {
  async function upgradeHarness() {
    const h = await harness();
    await seedProfile(h.db, "qp1", [
      qualityId({ source: "hdtv", resolution: "720p", edition: "" } as never),
      qualityId({ source: "web", resolution: "1080p", edition: "" } as never),
    ], qualityId({ source: "web", resolution: "1080p", edition: "" } as never));
    await seedSeries(h.db, h.mediaRoot, "qp1");

    const now = new Date().toISOString();
    await h.db.insert(schema.mediaFile).values({
      id: "mf_old", mediaType: "series", mediaId: "s1", episodeIds: ["s2e1"],
      relativePath: "Pack Show/Season 2/old.mkv", size: 500,
      quality: { source: "hdtv", resolution: "720p", edition: "" }, dateAdded: now,
    });
    mkdirSync(join(h.mediaRoot, "Pack Show", "Season 2"), { recursive: true });
    writeFileSync(join(h.mediaRoot, "Pack Show", "Season 2", "old.mkv"), Buffer.alloc(500));
    await h.db.update(schema.episode).set({ hasFile: true, mediaFileId: "mf_old" }).where(eq(schema.episode.id, "s2e1"));

    const packDir = stagePack(h.downloadsRoot, "Pack.Show.S02E01.1080p.WEB-DL", [{ name: "Pack.Show.S02E01.1080p.WEB-DL.mkv", size: 2000 }]);
    await packQueueEntry(h.db, "Pack.Show.S02E01.1080p.WEB-DL", { source: "web", resolution: "1080p", edition: "" });
    h.client.items = [{ downloadId: "d1", title: "Pack.Show.S02E01.1080p.WEB-DL", status: "completed", progress: 100, size: 2000, contentPath: packDir }];
    return h;
  }

  it("deletes the superseded file outright when no recycle bin is configured (default, unchanged behavior)", async () => {
    const h = await upgradeHarness();
    const oldPath = join(h.mediaRoot, "Pack Show", "Season 2", "old.mkv");

    await h.service.syncForClient(h.configured);

    expect(existsSync(oldPath)).toBe(false);
  });

  it("moves the superseded file into the recycle bin instead of deleting it when configured", async () => {
    const h = await upgradeHarness();
    const recycleBinPath = join(h.mediaRoot, "..", "recycle-bin");
    await h.config.upsert({ "media.recycleBinPath": recycleBinPath });
    const oldPath = join(h.mediaRoot, "Pack Show", "Season 2", "old.mkv");

    await h.service.syncForClient(h.configured);

    expect(existsSync(oldPath)).toBe(false);
    const recycled = readdirSync(recycleBinPath);
    expect(recycled).toHaveLength(1);
    expect(recycled[0]).toMatch(/^\d+-old\.mkv$/);
  });
});
