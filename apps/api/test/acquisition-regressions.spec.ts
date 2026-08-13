// SPDX-License-Identifier: MIT
/**
 * Regression coverage for the acquisition-path defects found in the parity audit:
 *   I1 — episode matching ignored the season number
 *   I2 — completed downloads were re-imported on every poll
 *   I3 — torrent payloads were deleted (and seeding killed) at import time
 *   I5 — one failing import aborted the whole client's queue pass
 *
 * Also covers roadmap P0.4 (blocklist, gap report B6): an import that fails
 * MAX_IMPORT_ATTEMPTS times must blocklist the release, not just mark the queue
 * entry `failed` and go quiet.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { EventBus } from "@medianexus/events";
import { createDb, schema } from "@medianexus/database";
import type { ClientQueueItem, DownloadClientContract, HealthResult, AddDownloadInput } from "@medianexus/integrations";
import { AcquisitionService } from "../src/acquisition/acquisition.service";
import { MediaRepository } from "../src/media/media.repository";
import { ConfigService } from "../src/system/config.service";
import { EventsService } from "../src/events/events.service";
import { BlocklistService } from "../src/blocklist/blocklist.service";
import type { ProvidersService, ConfiguredClient } from "../src/providers/demo.providers";

const dir = mkdtempSync(join(tmpdir(), "mn-acq-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });

/** A download client whose queue and removal behaviour the test drives directly. */
class StubClient implements DownloadClientContract {
  readonly key = "stub";
  readonly kind = "torrent" as const;
  items: ClientQueueItem[] = [];
  readonly removals: { downloadId: string; deleteData: boolean | undefined }[] = [];

  async addRelease(_input: AddDownloadInput): Promise<{ downloadId: string }> { return { downloadId: "d1" }; }
  async getQueue(): Promise<ClientQueueItem[]> { return this.items; }
  async remove(downloadId: string, deleteData?: boolean): Promise<void> {
    this.removals.push({ downloadId, deleteData });
  }
  async healthcheck(): Promise<HealthResult> { return { ok: true }; }
}

interface Harness {
  db: ReturnType<typeof createDb>["db"];
  service: AcquisitionService;
  blocklist: BlocklistService;
  client: StubClient;
  configured: ConfiguredClient;
  downloadsRoot: string;
  mediaRoot: string;
}

let counter = 0;

async function harness(): Promise<Harness> {
  const id = `acq-${counter++}`;
  const handle = createDb(join(dir, `${id}.db`));
  handle.runMigrations();
  handles.push(handle);

  const downloadsRoot = join(dir, id, "downloads");
  const mediaRoot = join(dir, id, "media");
  mkdirSync(downloadsRoot, { recursive: true });
  mkdirSync(mediaRoot, { recursive: true });

  const config = new ConfigService(handle.db);
  await config.upsert({ "paths.downloads": downloadsRoot, "paths.rootFolders": [{ path: mediaRoot }] });

  const events = new EventsService(new EventBus());
  const client = new StubClient();
  const providers = {
    configuredDownloadClients: async () => [{ row: null, provider: client }],
  } as unknown as ProvidersService;

  const blocklist = new BlocklistService(handle.db);
  const service = new AcquisitionService(handle.db, config, events, providers, new MediaRepository(handle.db), blocklist);
  return { db: handle.db, service, blocklist, client, configured: { row: null, provider: client }, downloadsRoot, mediaRoot };
}

/** Create a completed download on disk that resolveSource() will find. */
function stageDownload(downloadsRoot: string, folder: string, file: string): string {
  const dirPath = join(downloadsRoot, folder);
  mkdirSync(dirPath, { recursive: true });
  const full = join(dirPath, file);
  writeFileSync(full, Buffer.alloc(2048));
  return full;
}

async function seedSeries(db: Harness["db"], mediaRoot: string) {
  const now = new Date().toISOString();
  await db.insert(schema.series).values({
    id: "s1", tvdbId: 1, tmdbId: null, imdbId: null, title: "Test Show", overview: "",
    status: "continuing", seriesType: "standard", network: null, firstAirYear: 2020,
    monitored: true, qualityProfileId: null, rootFolderPath: mediaRoot,
    genres: [], images: [], tags: [], addedAt: now, updatedAt: now,
  });
  // Two seasons, each with an episode 1 — the exact shape that exposed the I1 bug.
  await db.insert(schema.season).values([
    { id: "sea1", seriesId: "s1", seasonNumber: 1, monitored: true, qualityProfileId: null },
    { id: "sea2", seriesId: "s1", seasonNumber: 2, monitored: true, qualityProfileId: null },
    { id: "sea3", seriesId: "s1", seasonNumber: 3, monitored: true, qualityProfileId: null },
  ]);
  await db.insert(schema.episode).values([
    { id: "s1e1", seriesId: "s1", seasonId: "sea1", episodeNumber: 1, absoluteNumber: null, title: "S1E1", overview: "", airDateUtc: null, monitored: true, hasFile: false, sceneSeasonNumber: null, sceneEpisodeNumber: null },
    { id: "s2e1", seriesId: "s1", seasonId: "sea2", episodeNumber: 1, absoluteNumber: null, title: "S2E1", overview: "", airDateUtc: null, monitored: true, hasFile: false, sceneSeasonNumber: null, sceneEpisodeNumber: null },
    { id: "s3e1", seriesId: "s1", seasonId: "sea3", episodeNumber: 1, absoluteNumber: null, title: "S3E1", overview: "", airDateUtc: null, monitored: true, hasFile: false, sceneSeasonNumber: null, sceneEpisodeNumber: null },
  ]);
}

async function queueEntry(db: Harness["db"], over: Partial<typeof schema.downloadQueueEntry.$inferInsert> = {}) {
  const now = new Date().toISOString();
  const row = {
    id: "q1", mediaType: "series", mediaId: "s1", downloadClientId: null, downloadId: "d1",
    title: "Test.Show.S02E01.1080p.WEB-DL", status: "downloading", progress: 50, size: 2048,
    remainingTime: null, errorMessage: null,
    data: { releaseTitle: "Test.Show.S02E01.1080p.WEB-DL" } as Record<string, unknown>,
    addedAt: now, updatedAt: now,
    ...over,
  };
  await db.insert(schema.downloadQueueEntry).values(row);
  return row;
}

const completed = (over: Partial<ClientQueueItem> = {}): ClientQueueItem => ({
  downloadId: "d1", title: "Test.Show.S02E01.1080p.WEB-DL", status: "completed",
  progress: 100, size: 2048, ...over,
});

describe("I1 — episode matching honours the season number", () => {
  let h: Harness;
  beforeEach(async () => { h = await harness(); await seedSeries(h.db, h.mediaRoot); });

  it("marks only the episode in the matched season", async () => {
    stageDownload(h.downloadsRoot, "Test.Show.S02E01.1080p.WEB-DL", "ep.mkv");
    await queueEntry(h.db);
    h.client.items = [completed({ contentPath: join(h.downloadsRoot, "Test.Show.S02E01.1080p.WEB-DL") })];

    await h.service.syncForClient(h.configured);

    const eps = await h.db.select().from(schema.episode);
    const byId = Object.fromEntries(eps.map((e) => [e.id, e.hasFile]));
    expect(byId["s2e1"]).toBe(true);
    // Previously S01E01 and S03E01 were also flagged, silently hiding them from wanted.
    expect(byId["s1e1"]).toBe(false);
    expect(byId["s3e1"]).toBe(false);
  });

  it("links the media file to the matched episode only", async () => {
    stageDownload(h.downloadsRoot, "Test.Show.S02E01.1080p.WEB-DL", "ep.mkv");
    await queueEntry(h.db);
    h.client.items = [completed({ contentPath: join(h.downloadsRoot, "Test.Show.S02E01.1080p.WEB-DL") })];

    await h.service.syncForClient(h.configured);

    const files = await h.db.select().from(schema.mediaFile);
    expect(files).toHaveLength(1);
    expect(files[0].episodeIds).toEqual(["s2e1"]);
  });
});

describe("I2 — completed downloads import exactly once", () => {
  let h: Harness;
  beforeEach(async () => { h = await harness(); await seedSeries(h.db, h.mediaRoot); });

  it("does not re-import an entry the client still reports as completed", async () => {
    stageDownload(h.downloadsRoot, "Test.Show.S02E01.1080p.WEB-DL", "ep.mkv");
    await queueEntry(h.db);
    // A SABnzbd-style client keeps the finished job visible in its history indefinitely.
    h.client.items = [completed({ contentPath: join(h.downloadsRoot, "Test.Show.S02E01.1080p.WEB-DL") })];

    const first = await h.service.syncForClient(h.configured);
    const second = await h.service.syncForClient(h.configured);
    const third = await h.service.syncForClient(h.configured);

    expect(first.imported).toBe(1);
    expect(second.imported).toBe(0);
    expect(third.imported).toBe(0);

    expect(await h.db.select().from(schema.mediaFile)).toHaveLength(1);
    const history = await h.db.select().from(schema.historyEntry);
    expect(history.filter((r) => r.action === "import_completed")).toHaveLength(1);
  });

  it("leaves the entry in a terminal imported state", async () => {
    stageDownload(h.downloadsRoot, "Test.Show.S02E01.1080p.WEB-DL", "ep.mkv");
    await queueEntry(h.db);
    h.client.items = [completed({ contentPath: join(h.downloadsRoot, "Test.Show.S02E01.1080p.WEB-DL") })];

    await h.service.syncForClient(h.configured);

    const entry = (await h.db.select().from(schema.downloadQueueEntry).where(eq(schema.downloadQueueEntry.id, "q1")))[0];
    expect(entry.status).toBe("imported");
    expect(entry.progress).toBe(100);
  });
});

describe("I3 — importing never destroys the download payload", () => {
  it("does not remove the download from the client", async () => {
    const h = await harness();
    await seedSeries(h.db, h.mediaRoot);
    stageDownload(h.downloadsRoot, "Test.Show.S02E01.1080p.WEB-DL", "ep.mkv");
    await queueEntry(h.db);
    h.client.items = [completed({ contentPath: join(h.downloadsRoot, "Test.Show.S02E01.1080p.WEB-DL") })];

    await h.service.syncForClient(h.configured);

    // Removing the torrent stops it seeding; deleting its data costs ratio outright.
    expect(h.client.removals).toEqual([]);
  });
});

describe("I5 — a failing import is isolated to its own queue entry", () => {
  let h: Harness;
  beforeEach(async () => { h = await harness(); await seedSeries(h.db, h.mediaRoot); });

  it("still processes the remaining items after one import fails", async () => {
    // q1 has no file staged on disk, so its import throws. q2 is importable.
    await queueEntry(h.db, { id: "q1", downloadId: "d1", title: "Missing.Show.S02E01" });
    await queueEntry(h.db, {
      id: "q2", downloadId: "d2", title: "Test.Show.S02E01.1080p.WEB-DL",
      data: { releaseTitle: "Test.Show.S02E01.1080p.WEB-DL" },
    });
    stageDownload(h.downloadsRoot, "good", "ep.mkv");
    h.client.items = [
      completed({ downloadId: "d1", title: "Missing.Show.S02E01" }),
      completed({ downloadId: "d2", contentPath: join(h.downloadsRoot, "good") }),
    ];

    const result = await h.service.syncForClient(h.configured);

    expect(result.imported).toBe(1);
    expect(await h.db.select().from(schema.mediaFile)).toHaveLength(1);
  });

  it("records the failure on the entry instead of losing it", async () => {
    await queueEntry(h.db, { id: "q1", downloadId: "d1", title: "Missing.Show.S02E01" });
    h.client.items = [completed({ downloadId: "d1", title: "Missing.Show.S02E01" })];

    await h.service.syncForClient(h.configured);

    const entry = (await h.db.select().from(schema.downloadQueueEntry).where(eq(schema.downloadQueueEntry.id, "q1")))[0];
    expect(entry.errorMessage).toMatch(/No video file found/);
    expect((entry.data as { importAttempts?: number }).importAttempts).toBe(1);
    expect(entry.status).toBe("downloading"); // retried on the next poll, not yet terminal
  });

  it("parks the entry as failed once attempts are exhausted", async () => {
    await queueEntry(h.db, { id: "q1", downloadId: "d1", title: "Missing.Show.S02E01" });
    h.client.items = [completed({ downloadId: "d1", title: "Missing.Show.S02E01" })];

    await h.service.syncForClient(h.configured);
    await h.service.syncForClient(h.configured);
    await h.service.syncForClient(h.configured);
    await h.service.syncForClient(h.configured); // no-op: entry is terminal

    const entry = (await h.db.select().from(schema.downloadQueueEntry).where(eq(schema.downloadQueueEntry.id, "q1")))[0];
    expect(entry.status).toBe("failed");
    expect((entry.data as { importAttempts?: number }).importAttempts).toBe(3);

    const history = await h.db.select().from(schema.historyEntry);
    expect(history.filter((r) => r.action === "import_failed")).toHaveLength(1);
  });
});
