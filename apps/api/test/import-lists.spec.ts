// SPDX-License-Identifier: MIT
/**
 * Roadmap P2, gap report C2 — import lists.
 *
 * Covers:
 *  - import-list CRUD (ImportListsService) on a real SQLite DB
 *  - import exclusions: add/list/remove, and the exclusion check during sync
 *  - end-to-end list sync against a TMDB list via a stubbed TmdbProvider fetch: new items
 *    are added (monitored), excluded items are skipped, already-in-library items are skipped
 *  - the auto-exclusion recorded when a movie/series is removed from the library
 */
import { AutoTagsService } from "../src/auto-tags/auto-tags.service";
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb, schema, type Db } from "@medianexus/database";
import { TmdbProvider } from "@medianexus/integrations";
import { ImportListsService } from "../src/import-lists/import-lists.service";
import { MetadataService } from "../src/metadata/metadata.service";
import { MoviesService } from "../src/movies/movies.service";

const dir = mkdtempSync(join(tmpdir(), "mn-c2-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });
let counter = 0;
function freshDb(): Db {
  const handle = createDb(join(dir, `c2-${counter++}.db`));
  handle.runMigrations();
  handles.push(handle);
  return handle.db;
}
const now = () => new Date().toISOString();

/** A TmdbProvider whose fetch returns a fixed TMDB list payload (page 1 only — the empty
 *  second page is what stops listItems' pagination, mirroring real TMDB). */
function stubTmdb(items: Array<{ id: number; media_type?: string }>): TmdbProvider {
  const fetchImpl = (async (url: unknown) => {
    const page = ((url as string).match(/[?&]page=(\d+)/)?.[1] ?? "1");
    return { ok: true, json: async () => (page === "1" ? { items } : { items: [] }) };
  }) as unknown as typeof fetch;
  return new TmdbProvider({ apiKey: "k", baseUrl: "http://mock" }, fetchImpl);
}

/** A fake MetadataService: `provider()` returns the stub tmdb; `addFromDiscover` records
 *  additions and reflects an `existing` set (simulating the real already-in-library check). */
function fakeMetadata(tmdb: TmdbProvider, existing: Set<number>, added: Set<number>): MetadataService {
  return {
    provider: async () => tmdb,
    addFromDiscover: async (_mediaType: string, tmdbId: number) => {
      if (existing.has(tmdbId)) return { id: String(tmdbId), created: false };
      added.add(tmdbId);
      return { id: String(tmdbId), created: true };
    },
  } as unknown as MetadataService;
}

describe("C2 import-list CRUD + exclusions", () => {
  it("creates, lists, updates, and deletes an import list", async () => {
    const db = freshDb();
    const svc = new ImportListsService(db, fakeMetadata(stubTmdb([]), new Set(), new Set()));
    const row = await svc.create({ provider: "tmdb", name: "My Watchlist", config: { listId: 123 } });
    expect(row.provider).toBe("tmdb");
    const listed = await svc.list();
    expect(listed.map((l) => l.name)).toEqual(["My Watchlist"]);
    await svc.update(row.id, { enabled: false, name: "Renamed" });
    const updated = (await svc.list())[0];
    expect(updated.name).toBe("Renamed");
    expect(updated.enabled).toBe(false);
    await svc.remove(row.id);
    expect((await svc.list()).length).toBe(0);
  });

  it("adds and removes exclusions", async () => {
    const db = freshDb();
    const svc = new ImportListsService(db, fakeMetadata(stubTmdb([]), new Set(), new Set()));
    await svc.addExclusion({ mediaType: "movie", externalId: "100", reason: "don't want it" });
    expect((await svc.listExclusions()).length).toBe(1);
    await svc.addExclusion({ mediaType: "movie", externalId: "100" }); // idempotent (unique idx)
    expect((await svc.listExclusions()).length).toBe(1);
    const id = (await svc.listExclusions())[0].id;
    await svc.removeExclusion(id);
    expect((await svc.listExclusions()).length).toBe(0);
  });
});

describe("C2 list sync", () => {
  it("adds new items, skips excluded ones, and skips already-in-library ones", async () => {
    const db = freshDb();
    const items = [
      { id: 100, media_type: "movie" },
      { id: 200, media_type: "tv" },
      { id: 300, media_type: "movie" },
    ];
    const existing = new Set<number>([300]); // 300 is already in the library
    const added = new Set<number>();
    const svc = new ImportListsService(db, fakeMetadata(stubTmdb(items), existing, added));
    const list = await svc.create({ provider: "tmdb", name: "L", config: { listId: 999 } });

    // exclude 100 before the sync
    await svc.addExclusion({ mediaType: "movie", externalId: "100" });

    const res = await svc.syncList(list.id);
    expect(res.added).toBe(1); // only 200 (series) added
    expect(res.skipped).toBe(2); // 100 excluded, 300 already in library
    expect([...added]).toEqual([200]);

    const synced = (await db.select().from(schema.importList).where(eq(schema.importList.id, list.id)).all())[0] as any;
    expect(synced.lastSyncAt).toBeTruthy();
    expect(synced.lastError).toBeNull();
  });

  it("runAll syncs every enabled list and records failures per-list", async () => {
    const db = freshDb();
    const items = [{ id: 50, media_type: "movie" as const }];
    const added = new Set<number>();
    const svc = new ImportListsService(db, fakeMetadata(stubTmdb(items), new Set(), added));
    await svc.create({ provider: "tmdb", name: "OK", config: { listId: 1 } });
    const bad = await svc.create({ provider: "tmdb", name: "Missing listId", config: { listId: undefined } });
    await svc.create({ provider: "tmdb", name: "Disabled", config: { listId: 2 }, enabled: false });
    void bad;

    const res = await svc.runAll();
    expect(res.lists).toBe(2); // only enabled lists
    expect(res.added).toBe(1); // the OK list adds one item
    expect(res.failed).toBe(1); // the missing-listId list failed
    expect([...added]).toEqual([50]);
  });
});

describe("C2 auto-exclusion on library removal", () => {
  it("movie.remove() records an exclusion so the title isn't re-added", async () => {
    const db = freshDb();
    const nowIso = now();
    db.insert(schema.movie).values({
      id: "m1", tmdbId: 777, imdbId: null, title: "Removed Movie", originalTitle: null, overview: "", status: "released",
      releaseDate: null, monitored: true, qualityProfileId: null, rootFolderPath: "/m", minimumAvailability: "announced",
      genres: [], images: [], tags: [], hasFile: false, addedAt: nowIso, updatedAt: nowIso,
    }).run();
    const svc = new MoviesService(db, { publish: () => {} } as never, new AutoTagsService(db));
    await svc.remove("m1");
    const exc = (await db.select().from(schema.importExclusion).where(eq(schema.importExclusion.externalId, "777")).all())[0] as any;
    expect(exc.mediaType).toBe("movie");
    expect(exc.reason).toContain("removed");
  });
});
