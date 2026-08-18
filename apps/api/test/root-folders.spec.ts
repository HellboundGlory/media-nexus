// SPDX-License-Identifier: MIT
/**
 * Roadmap P1 (gap report B8): root folders promoted to a real entity (path/name/default,
 * live accessibility + free space), remote path mapping, and a free-space guard at both
 * grab time (packages/domain/src/decision.test.ts covers the pure spec) and import time.
 * This covers the API-layer pieces: RootFoldersService CRUD + default reassignment,
 * RemotePathMappingsService, and AcquisitionService's consumption of both.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
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
  it("rejects a path that doesn't exist, with a structured path_missing reason (create-if-missing off)", async () => {
    const db = await freshDb();
    const svc = new RootFoldersService(db, new ConfigService(db));
    const missing = join(dir, "does-not-exist");
    await expect(svc.create({ path: missing, name: "" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { reason: "path_missing" },
    });
    expect(existsSync(missing)).toBe(false); // must NOT silently create it
  });

  it("creates the directory and the row when createIfMissing is set", async () => {
    const db = await freshDb();
    const svc = new RootFoldersService(db, new ConfigService(db));
    const missing = join(dir, "will-be-created");
    const row = await svc.create({ path: missing, name: "", createIfMissing: true });
    expect(existsSync(missing)).toBe(true);
    expect(row.path).toBe(missing);
  });

  it("rejects a path that exists but is not a directory, even with createIfMissing", async () => {
    const db = await freshDb();
    const svc = new RootFoldersService(db, new ConfigService(db));
    const file = join(dir, "afile");
    writeFileSync(file, "x");
    await expect(svc.create({ path: file, name: "", createIfMissing: true })).rejects.toThrow();
  });

  it("makes the first root folder the default for BOTH media types automatically, even when not requested", async () => {
    const db = await freshDb();
    const svc = new RootFoldersService(db, new ConfigService(db));
    const row = await svc.create({ path: mkdtempSync(join(dir, "root-")), name: "" });
    expect(row.isDefaultMovie).toBe(true);
    expect(row.isDefaultSeries).toBe(true);
  });

  it("keeps movie and series defaults independent (per-type invariant)", async () => {
    const db = await freshDb();
    const svc = new RootFoldersService(db, new ConfigService(db));
    const a = await svc.create({ path: mkdtempSync(join(dir, "root-")), name: "" }); // first -> both defaults
    const b = await svc.create({ path: mkdtempSync(join(dir, "root-")), name: "" });
    // Make B the movie default: this must clear A's MOVIE flag but NOT A's series flag.
    await svc.update(b.id, { isDefaultMovie: true });
    let list = await svc.list();
    expect(list.find((r) => r.id === a.id)?.isDefaultMovie).toBe(false);
    expect(list.find((r) => r.id === b.id)?.isDefaultMovie).toBe(true);
    expect(list.find((r) => r.id === a.id)?.isDefaultSeries).toBe(true); // series default untouched
    // Now make B the series default too: clears A's series flag, movie flags unchanged.
    await svc.update(b.id, { isDefaultSeries: true });
    list = await svc.list();
    expect(list.find((r) => r.id === b.id)?.isDefaultSeries).toBe(true);
    expect(list.find((r) => r.id === a.id)?.isDefaultSeries).toBe(false);
    expect(list.find((r) => r.id === b.id)?.isDefaultMovie).toBe(true); // movie default untouched
  });

  it("update() can demote one type without touching the other type's default on the same row", async () => {
    const db = await freshDb();
    const svc = new RootFoldersService(db, new ConfigService(db));
    const a = await svc.create({ path: mkdtempSync(join(dir, "root-")), name: "", createIfMissing: true });
    const b = await svc.create({ path: mkdtempSync(join(dir, "root-")), name: "", createIfMissing: true });
    // a is default for both (first row). Set b as the movie default only.
    await svc.update(b.id, { isDefaultMovie: true });
    const aAfter = await svc.get(a.id);
    expect(aAfter.isDefaultSeries).toBe(true);
    expect(aAfter.isDefaultMovie).toBe(false);
    const bDef = await svc.getDefault("movie");
    expect(bDef?.id).toBe(b.id);
    const seriesDef = await svc.getDefault("series");
    expect(seriesDef?.id).toBe(a.id); // a is still the series default
  });

  it("reports live accessibility and free space for an existing path", async () => {
    const db = await freshDb();
    const svc = new RootFoldersService(db, new ConfigService(db));
    const row = await svc.create({ path: mkdtempSync(join(dir, "root-")), name: "" });
    const view = await svc.get(row.id);
    expect(view.accessible).toBe(true);
    expect(view.freeBytes).toBeGreaterThan(0);
  });

  it("rejects removal when a movie is assigned to the root folder", async () => {
    const db = await freshDb();
    const svc = new RootFoldersService(db, new ConfigService(db));
    const p = mkdtempSync(join(dir, "root-"));
    const row = await svc.create({ path: p, name: "", isDefaultMovie: true, isDefaultSeries: true });
    const now = new Date().toISOString();
    await db.insert(schema.movie).values({
      id: "m1", tmdbId: 1, title: "X", overview: "", status: "released", releaseDate: "2020-01-01",
      monitored: true, qualityProfileId: null, rootFolderPath: p, minimumAvailability: "announced",
      genres: [], images: [], tags: [], hasFile: false, addedAt: now, updatedAt: now,
    });
    await expect(svc.remove(row.id)).rejects.toThrow();
  });

  it("promotes the next-oldest root folder to movie default when the movie default is removed", async () => {
    const db = await freshDb();
    const svc = new RootFoldersService(db, new ConfigService(db));
    const a = await svc.create({ path: mkdtempSync(join(dir, "root-")), name: "" }); // first -> movie+series default
    const b = await svc.create({ path: mkdtempSync(join(dir, "root-")), name: "" });
    await svc.remove(a.id);
    const remainingMovie = await svc.getDefault("movie");
    expect(remainingMovie?.id).toBe(b.id);
    const remainingSeries = await svc.getDefault("series");
    expect(remainingSeries?.id).toBe(b.id);
  });
});

describe("root_folder forward migration (0009, per-type default flags)", () => {
  it("carries an existing single global is_default forward into BOTH per-type flags (non-destructive)", () => {
    const dbPath = join(dir, "rf-oldshape.db");
    const db = new Database(dbPath);
    // Pre-0009 root_folder shape: one global `is_default` boolean (single-default invariant).
    db.exec(
      "CREATE TABLE `root_folder` (id text PRIMARY KEY NOT NULL, path text NOT NULL, name text NOT NULL DEFAULT '', is_default integer DEFAULT false NOT NULL, created_at text NOT NULL);" +
      "CREATE UNIQUE INDEX `root_folder_path_idx` ON `root_folder` (path);",
    );
    db.exec("INSERT INTO root_folder (id, path, name, is_default, created_at) VALUES ('rf1','/a','A',1,'2024-01-01T00:00:00.000Z'),('rf2','/b','B',0,'2024-01-02T00:00:00.000Z');");

    // Real generated migration file that adds the per-type flags to root_folder.
    const migDir = resolve(__dirname, "../../../packages/database/migrations");
    const files = readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort();
    const mig = files.filter((f) => {
      const s = readFileSync(join(migDir, f), "utf8");
      return s.includes("root_folder") && s.includes("is_default_movie");
    }).pop();
    if (!mig) throw new Error("no root_folder per-type migration found");
    for (const stmt of readFileSync(join(migDir, mig), "utf8").split("--> statement-breakpoint")) {
      const s = stmt.trim();
      if (s) db.exec(s);
    }

    // The row that was the global default becomes the default for BOTH types; the other row
    // stays non-default for both; the old column is gone.
    const rows = db.prepare("SELECT id, is_default_movie, is_default_series FROM root_folder ORDER BY id").all();
    expect(rows).toEqual([
      { id: "rf1", is_default_movie: 1, is_default_series: 1 },
      { id: "rf2", is_default_movie: 0, is_default_series: 0 },
    ]);
    const cols = (db.prepare("PRAGMA table_info(root_folder)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain("is_default");
    db.close();
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
    const rootFolders = new RootFoldersService(db, new ConfigService(db));
    await rootFolders.create({ path: mediaRoot, name: "", isDefaultMovie: true, isDefaultSeries: true });

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
    const rootFolders = new RootFoldersService(db, new ConfigService(db));
    await rootFolders.create({ path: mediaRoot, name: "", isDefaultMovie: true, isDefaultSeries: true });

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
