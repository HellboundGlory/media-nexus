// SPDX-License-Identifier: MIT
/**
 * Roadmap P1 (gap report B8): root folders promoted to a real entity (path/name/default,
 * live accessibility + free space), remote path mapping, and a free-space guard at both
 * grab time (packages/domain/src/decision.test.ts covers the pure spec) and import time.
 * This covers the API-layer pieces: RootFoldersService CRUD + default reassignment,
 * RemotePathMappingsService, and AcquisitionService's consumption of both.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@medianexus/database";
import { EventBus } from "@medianexus/events";
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

const dir = mkdtempSync(join(tmpdir(), "mn-rootfolders-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });

let counter = 0;
async function freshDb() {
  const handle = createDb(join(dir, `rf-${counter++}.db`));
  handle.runMigrations();
  handles.push(handle);
  return handle.db;
}

describe("RootFoldersService", () => {
  it("rejects a path that doesn't exist on disk", async () => {
    const db = await freshDb();
    const svc = new RootFoldersService(db);
    await expect(svc.create({ path: join(dir, "does-not-exist"), name: "", isDefault: false })).rejects.toThrow();
  });

  it("makes the first root folder the default automatically, even when isDefault wasn't requested", async () => {
    const db = await freshDb();
    const svc = new RootFoldersService(db);
    const row = await svc.create({ path: mkdtempSync(join(dir, "root-")), name: "", isDefault: false });
    expect(row.isDefault).toBe(true);
  });

  it("only one root folder is ever default", async () => {
    const db = await freshDb();
    const svc = new RootFoldersService(db);
    const a = await svc.create({ path: mkdtempSync(join(dir, "root-")), name: "", isDefault: false });
    const b = await svc.create({ path: mkdtempSync(join(dir, "root-")), name: "", isDefault: true });
    const list = await svc.list();
    expect(list.find((r) => r.id === a.id)?.isDefault).toBe(false);
    expect(list.find((r) => r.id === b.id)?.isDefault).toBe(true);
  });

  it("reports live accessibility and free space for an existing path", async () => {
    const db = await freshDb();
    const svc = new RootFoldersService(db);
    const row = await svc.create({ path: mkdtempSync(join(dir, "root-")), name: "", isDefault: false });
    const view = await svc.get(row.id);
    expect(view.accessible).toBe(true);
    expect(view.freeBytes).toBeGreaterThan(0);
  });

  it("rejects removal when a movie is assigned to the root folder", async () => {
    const db = await freshDb();
    const svc = new RootFoldersService(db);
    const p = mkdtempSync(join(dir, "root-"));
    const row = await svc.create({ path: p, name: "", isDefault: true });
    const now = new Date().toISOString();
    await db.insert(schema.movie).values({
      id: "m1", tmdbId: 1, title: "X", overview: "", status: "released", releaseDate: "2020-01-01",
      monitored: true, qualityProfileId: null, rootFolderPath: p, minimumAvailability: "announced",
      genres: [], images: [], tags: [], hasFile: false, addedAt: now, updatedAt: now,
    });
    await expect(svc.remove(row.id)).rejects.toThrow();
  });

  it("promotes the next-oldest root folder to default when the default is removed", async () => {
    const db = await freshDb();
    const svc = new RootFoldersService(db);
    const a = await svc.create({ path: mkdtempSync(join(dir, "root-")), name: "", isDefault: false }); // first -> default
    const b = await svc.create({ path: mkdtempSync(join(dir, "root-")), name: "", isDefault: false });
    await svc.remove(a.id);
    const remaining = await svc.getDefault();
    expect(remaining?.id).toBe(b.id);
  });
});

describe("RemotePathMappingsService", () => {
  it("rejects a mapping for a download client that doesn't exist", async () => {
    const db = await freshDb();
    const svc = new RemotePathMappingsService(db);
    await expect(svc.create({ downloadClientId: "nope", remotePath: "/x", localPath: "/y" })).rejects.toThrow();
  });

  it("forClient() returns the longest matching prefix first", async () => {
    const db = await freshDb();
    const now = new Date().toISOString();
    await db.insert(schema.downloadClient).values({
      id: "dc1", name: "Test", implementation: "sabnzbd", kind: "usenet", enabled: true, priority: 1,
      settings: {}, tags: [], createdAt: now, updatedAt: now,
    });
    const svc = new RemotePathMappingsService(db);
    await svc.create({ downloadClientId: "dc1", remotePath: "/downloads", localPath: "/mnt/a" });
    await svc.create({ downloadClientId: "dc1", remotePath: "/downloads/movies", localPath: "/mnt/b" });
    const mappings = await svc.forClient("dc1");
    expect(mappings[0].remotePath).toBe("/downloads/movies");
  });
});

/** A download client whose queue the test drives directly. */
class StubClient implements DownloadClientContract {
  readonly key = "stub";
  readonly kind = "torrent" as const;
  items: ClientQueueItem[] = [];
  async addRelease(_input: AddDownloadInput): Promise<{ downloadId: string }> { return { downloadId: "d1" }; }
  async getQueue(): Promise<ClientQueueItem[]> { return this.items; }
  async remove(): Promise<void> {}
  async healthcheck(): Promise<HealthResult> { return { ok: true }; }
}

describe("AcquisitionService — remote path mapping (roadmap P1, gap report B8)", () => {
  it("translates a client-reported contentPath through a configured mapping before locating the file", async () => {
    const db = await freshDb();
    const downloadsRoot = mkdtempSync(join(dir, "downloads-"));
    const mediaRoot = mkdtempSync(join(dir, "media-"));
    const config = new ConfigService(db);
    await config.upsert({ "paths.downloads": downloadsRoot });
    const rootFolders = new RootFoldersService(db);
    await rootFolders.create({ path: mediaRoot, name: "", isDefault: true });

    const now = new Date().toISOString();
    await db.insert(schema.downloadClient).values({
      id: "dc1", name: "Remote Client", implementation: "sabnzbd", kind: "usenet",
      enabled: true, priority: 1, settings: {}, tags: [], createdAt: now, updatedAt: now,
    });
    const remotePathMappings = new RemotePathMappingsService(db);
    // The client reports content under a prefix that doesn't exist on this filesystem at
    // all — only the mapped local path does. If translation didn't run, resolveContent()
    // would find nothing and import would fail outright.
    const remotePrefix = "/container/downloads";
    const localReal = mkdtempSync(join(dir, "local-"));
    await remotePathMappings.create({ downloadClientId: "dc1", remotePath: remotePrefix, localPath: localReal });

    const title = "Mapped.Movie.2021.1080p.WEB-DL";
    const contentDir = join(localReal, title);
    mkdirSync(contentDir, { recursive: true });
    writeFileSync(join(contentDir, `${title}.mkv`), Buffer.alloc(2048));

    await db.insert(schema.movie).values({
      id: "m1", tmdbId: 1, title: "Mapped Movie", overview: "", status: "released", releaseDate: "2021-01-01",
      monitored: true, qualityProfileId: null, rootFolderPath: "", minimumAvailability: "announced",
      genres: [], images: [], tags: [], hasFile: false, addedAt: now, updatedAt: now,
    });
    await db.insert(schema.downloadQueueEntry).values({
      id: "q1", mediaType: "movie", mediaId: "m1", downloadClientId: "dc1", downloadId: "d1",
      title, status: "downloading", progress: 50, size: 2048, remainingTime: null, errorMessage: null,
      data: { releaseTitle: title }, addedAt: now, updatedAt: now,
    });

    const events = new EventsService(new EventBus());
    const client = new StubClient();
    client.items = [{ downloadId: "d1", title, status: "completed", progress: 100, size: 2048, contentPath: join(remotePrefix, title) }];
    const providers = {
      configuredDownloadClients: async () => [{ row: { id: "dc1" }, provider: client }],
    } as unknown as ProvidersService;
    const blocklist = new BlocklistService(db);
    const service = new AcquisitionService(
      db, config, events, providers, new MediaRepository(db), blocklist, rootFolders, remotePathMappings, new RecycleBinService(config), new ProviderStatusService(db, config),
    );

    const configured = { row: { id: "dc1" }, provider: client } as unknown as ConfiguredClient;
    await service.syncForClient(configured);

    const movie = await db.select().from(schema.movie).where(eq(schema.movie.id, "m1")).limit(1);
    expect(movie[0]?.hasFile).toBe(true);
  });
});

describe("AcquisitionService — import-time free-space guard (roadmap P1, gap report B8)", () => {
  it("fails the import instead of writing when the target root is below the configured minimum free space", async () => {
    const db = await freshDb();
    const downloadsRoot = mkdtempSync(join(dir, "downloads-"));
    const mediaRoot = mkdtempSync(join(dir, "media-"));
    const config = new ConfigService(db);
    // An unreasonably large minimum makes every real filesystem "insufficient" — this
    // proves the guard actually blocks the write rather than just checking the free-space
    // number is plausible.
    await config.upsert({ "paths.downloads": downloadsRoot, "media.minimumFreeSpaceMb": 10 ** 9 });
    const rootFolders = new RootFoldersService(db);
    await rootFolders.create({ path: mediaRoot, name: "", isDefault: true });

    const title = "Huge.Movie.2021.1080p.WEB-DL";
    const contentDir = join(downloadsRoot, "complete", title);
    mkdirSync(contentDir, { recursive: true });
    writeFileSync(join(contentDir, `${title}.mkv`), Buffer.alloc(2048));

    const now = new Date().toISOString();
    await db.insert(schema.movie).values({
      id: "m1", tmdbId: 1, title: "Huge Movie", overview: "", status: "released", releaseDate: "2021-01-01",
      monitored: true, qualityProfileId: null, rootFolderPath: "", minimumAvailability: "announced",
      genres: [], images: [], tags: [], hasFile: false, addedAt: now, updatedAt: now,
    });
    await db.insert(schema.downloadQueueEntry).values({
      id: "q1", mediaType: "movie", mediaId: "m1", downloadClientId: null, downloadId: "d1",
      title, status: "downloading", progress: 50, size: 2048, remainingTime: null, errorMessage: null,
      data: { releaseTitle: title }, addedAt: now, updatedAt: now,
    });

    const events = new EventsService(new EventBus());
    const client = new StubClient();
    client.items = [{ downloadId: "d1", title, status: "completed", progress: 100, size: 2048 }];
    const providers = {
      configuredDownloadClients: async () => [{ row: null, provider: client }],
    } as unknown as ProvidersService;
    const blocklist = new BlocklistService(db);
    const service = new AcquisitionService(
      db, config, events, providers, new MediaRepository(db), blocklist, rootFolders, new RemotePathMappingsService(db), new RecycleBinService(config), new ProviderStatusService(db, config),
    );

    const configured = { row: null, provider: client } as unknown as ConfiguredClient;
    await service.syncForClient(configured);

    const movie = await db.select().from(schema.movie).where(eq(schema.movie.id, "m1")).limit(1);
    expect(movie[0]?.hasFile).toBe(false);
    const entry = await db.select().from(schema.downloadQueueEntry).where(eq(schema.downloadQueueEntry.id, "q1")).limit(1);
    expect(entry[0]?.status).toBe("downloading"); // first attempt only — not yet exhausted
    expect((entry[0]?.data as { importAttempts?: number })?.importAttempts).toBe(1);
  });
});
