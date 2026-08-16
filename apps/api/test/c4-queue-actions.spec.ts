// SPDX-License-Identifier: MIT
/**
 * Roadmap P1, gap report C4 — queue/history retry, manual-import, and bulk-remove.
 *
 * Exercises the new manual-intervention write paths against a real SQLite DB + staged
 * media on disk (the same harness as import-engine.spec.ts):
 *  - manualImportQueueEntry() imports a queue entry from an explicit file path (reusing
 *    the decideImportFile pipeline via importCompletedEntry), flips movie.hasFile, writes
 *    a media_file row, and closes the queue entry as imported
 *  - retryQueueEntry() resets a failed entry's import budget and re-attempts the import
 *    (success path imports; no-payload path returns {ok:false} and re-arms the entry to a
 *    non-terminal status instead of re-blocklisting)
 *  - bulkRemoveQueue() / bulkRemoveHistory() delete multiple rows (and log `removed` rows)
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { EventBus } from "@medianexus/events";
import { createDb, schema, type Db } from "@medianexus/database";
import { AcquisitionService } from "../src/acquisition/acquisition.service";
import { ActivityService } from "../src/activity/activity.service";
import { MediaRepository } from "../src/media/media.repository";
import { ConfigService } from "../src/system/config.service";
import { EventsService } from "../src/events/events.service";
import { BlocklistService } from "../src/blocklist/blocklist.service";
import { RootFoldersService } from "../src/root-folders/root-folders.service";
import { RemotePathMappingsService } from "../src/remote-path-mappings/remote-path-mappings.service";
import { RecycleBinService } from "../src/media/recycle-bin.service";
import { ProviderStatusService } from "../src/providers/provider-status.service";
import type { ProvidersService } from "../src/providers/demo.providers";

const dir = mkdtempSync(join(tmpdir(), "mn-c4-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });
let counter = 0;

interface Harness {
  db: Db;
  service: AcquisitionService;
  activity: ActivityService;
  downloadsRoot: string;
  mediaRoot: string;
}

async function harness(): Promise<Harness> {
  const id = `c4-${counter++}`;
  const handle = createDb(join(dir, `${id}.db`));
  handle.runMigrations();
  handles.push(handle);
  const db = handle.db;
  const downloadsRoot = join(dir, id, "downloads");
  const mediaRoot = join(dir, id, "media");
  mkdirSync(downloadsRoot, { recursive: true });
  mkdirSync(mediaRoot, { recursive: true });

  const config = new ConfigService(db);
  await config.upsert({ "paths.downloads": downloadsRoot } as never);
  const rootFolders = new RootFoldersService(db, new ConfigService(db));
  await rootFolders.create({ path: mediaRoot, name: "", isDefault: true });
  const events = new EventsService(new EventBus());
  const providers = {} as ProvidersService;
  const blocklist = new BlocklistService(db);
  const service = new AcquisitionService(
    db, config, events, providers, new MediaRepository(db), blocklist,
    rootFolders, new RemotePathMappingsService(db), new RecycleBinService(config), new ProviderStatusService(db, config),
  );
  const activity = new ActivityService(db, { configuredDownloadClients: async () => [] } as never as ProvidersService);
  return { db, service, activity, downloadsRoot, mediaRoot };
}

const now = () => new Date().toISOString();

function seedMovie(h: Harness): void {
  h.db.insert(schema.movie).values({
    id: "m1", tmdbId: 1, imdbId: null, title: "My Movie", originalTitle: null, overview: "", status: "released",
    releaseDate: "2024-01-01", monitored: true, qualityProfileId: null, rootFolderPath: h.mediaRoot,
    minimumAvailability: "announced", genres: [], images: [], tags: [], hasFile: false, addedAt: now(), updatedAt: now(),
  }).run();
}

function seedQueueEntry(h: Harness, over: Record<string, unknown> = {}, data: Record<string, unknown> = {}): string {
  h.db.insert(schema.downloadQueueEntry).values({
    id: "q1", mediaType: "movie", mediaId: "m1", downloadClientId: null, downloadId: "d1", title: "My.Movie.2024.1080p",
    status: "failed", progress: 100, size: 0, remainingTime: null, errorMessage: "import failed",
    data: { quality: { source: "bluray", resolution: "1080p", edition: "" }, ...data },
    addedAt: now(), updatedAt: now(),
    ...over,
  }).run();
  return "q1";
}

function stageVideo(dirPath: string, name: string): string {
  mkdirSync(dirPath, { recursive: true });
  const full = join(dirPath, name);
  writeFileSync(full, Buffer.alloc(4096));
  return full;
}

describe("C4 manual-import", () => {
  it("imports a queue entry from an explicit path and closes it as imported", async () => {
    const h = await harness();
    seedMovie(h);
    seedQueueEntry(h);
    const src = stageVideo(join(h.downloadsRoot, "picked"), "My.Movie.2024.1080p.mkv");

    const res = await h.service.manualImportQueueEntry("q1", { path: src });
    expect(res.imported.length).toBe(1);

    const movie = h.db.select().from(schema.movie).where(eq(schema.movie.id, "m1")).all()[0] as any;
    expect(movie.hasFile).toBe(true);
    const file = h.db.select().from(schema.mediaFile).where(eq(schema.mediaFile.mediaId, "m1")).all()[0] as any;
    expect(file.mediaType).toBe("movie");
    expect(existsSync(join(h.mediaRoot, file.relativePath))).toBe(true); // physically placed
    const q = h.db.select().from(schema.downloadQueueEntry).where(eq(schema.downloadQueueEntry.id, "q1")).all()[0] as any;
    expect(q.status).toBe("imported");
  });

  it("rejects an explicit path that has no importable video", async () => {
    const h = await harness();
    seedMovie(h);
    seedQueueEntry(h);
    await expect(h.service.manualImportQueueEntry("q1", { path: join(h.downloadsRoot, "missing-dir") })).rejects.toThrow();
    // entry not closed out
    const q = h.db.select().from(schema.downloadQueueEntry).where(eq(schema.downloadQueueEntry.id, "q1")).all()[0] as any;
    expect(q.status).toBe("failed");
  });
});

describe("C4 retry", () => {
  it("re-arms a failed entry and imports it when the payload is present", async () => {
    const h = await harness();
    seedMovie(h);
    seedQueueEntry(h, { data: { importAttempts: 3, lastImportError: "x" } as never });
    // retry auto-resolves: place the payload where conventional resolution expects it —
    // a directory named sanitizeEntry(title) under downloadsRoot.
    const convDir = join(h.downloadsRoot, "MyMovie20241080p");
    mkdirSync(convDir, { recursive: true });
    writeFileSync(join(convDir, "My.Movie.2024.1080p.mkv"), Buffer.alloc(4096));

    const out = await h.service.retryQueueEntry("q1");
    expect(out.ok).toBe(true);
    const q = h.db.select().from(schema.downloadQueueEntry).where(eq(schema.downloadQueueEntry.id, "q1")).all()[0] as any;
    expect(q.status).toBe("imported");
  });

  it("returns {ok:false} and re-arms (does not blocklist) when no payload is present", async () => {
    const h = await harness();
    seedMovie(h);
    seedQueueEntry(h);
    // no file staged anywhere under downloadsRoot
    const out = await h.service.retryQueueEntry("q1");
    expect(out.ok).toBe(false);
    expect(typeof out.message).toBe("string");
    const q = h.db.select().from(schema.downloadQueueEntry).where(eq(schema.downloadQueueEntry.id, "q1")).all()[0] as any;
    expect(q.status).toBe("downloading"); // re-armed, not terminal, not re-blocklisted
  });
});

describe("C4 bulk-remove", () => {
  it("removes multiple queue entries, writing a removed history row each", async () => {
    const h = await harness();
    seedMovie(h);
    for (const id of ["q1", "q2", "q3"]) {
      h.db.insert(schema.downloadQueueEntry).values({
        id, mediaType: "movie", mediaId: "m1", downloadClientId: null, downloadId: `d-${id}`, title: `T ${id}`,
        status: "failed", progress: 0, size: 0, remainingTime: null, errorMessage: null, data: {},
        addedAt: now(), updatedAt: now(),
      }).run();
    }
    const { removed } = await h.activity.bulkRemoveQueue(["q1", "q2"]);
    expect(removed).toBe(2);
    const remaining = h.db.select().from(schema.downloadQueueEntry).all().map((r) => r.id);
    expect(remaining).toEqual(["q3"]);
    const hist = h.db.select().from(schema.historyEntry).where(eq(schema.historyEntry.action, "removed")).all();
    expect(hist.length).toBe(2);
  });

  it("removes history rows by id", async () => {
    const h = await harness();
    for (const id of ["h1", "h2", "h3"]) {
      h.db.insert(schema.historyEntry).values({ id, mediaType: "movie", mediaId: "m1", action: "grabbed", data: {}, createdAt: now() }).run();
    }
    const { removed } = await h.activity.bulkRemoveHistory(["h1", "h3"]);
    expect(removed).toBe(2);
    const remaining = h.db.select().from(schema.historyEntry).all().map((r) => r.id);
    expect(remaining).toEqual(["h2"]);
  });
});
