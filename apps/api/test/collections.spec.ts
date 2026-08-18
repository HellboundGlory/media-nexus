// SPDX-License-Identifier: MIT
/**
 * UNI-021 — Collections subsystem. Service-level tests over a real temp DB with a stubbed TMDB
 * provider (same approach as quality-profile-gating.spec.ts):
 *  - upsert hook: refreshing a movie that belongs to a TMDB collection creates an unmonitored
 *    collection row with parts populated from a real /collection/{id} fetch.
 *  - sync() computes inLibrary/missing-count against real seeded movie rows.
 *  - Monitor-ON marks owned movies monitored immediately (the one piece of custom logic that
 *    deviates from upstream / Import Lists — must be tested, not trusted).
 *  - bulk-edit "No Change" omission + per-id failure aggregation.
 *  - sync honors import_exclusion (an excluded part is never re-added).
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { EventBus } from "@medianexus/events";
import { createDb, schema, type CollectionPart } from "@medianexus/database";
import { MoviesService } from "../src/movies/movies.service";
import { SeriesService } from "../src/series/series.service";
import { MetadataService } from "../src/metadata/metadata.service";
import { AutoTagsService } from "../src/auto-tags/auto-tags.service";
import { EventsService } from "../src/events/events.service";
import { ConfigService } from "../src/system/config.service";
import { CollectionsService } from "../src/collections/collections.service";
import type { TmdbProvider } from "@medianexus/integrations";

const dir = mkdtempSync(join(tmpdir(), "mn-collections-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });

let counter = 0;
async function freshDb() {
  const handle = createDb(join(dir, `col-${counter++}.db`));
  handle.runMigrations();
  handles.push(handle);
  return handle.db;
}

const now = () => new Date().toISOString();

/** Stub TMDB provider: `getCollection` returns a fixed 3-part collection; `getDetails` gives the
 *  movie 4242 a collection link (so the upsert hook fires) and everything else is plain. */
function stubProvider(): TmdbProvider {
  return {
    getDetails: async (_mediaType: string, externalId: string) => ({
      externalId, title: "Movie", releaseDate: "2020-01-01", overview: "", genres: [], images: [],
      collectionTmdbId: externalId === "4242" ? 999 : null,
      collectionName: externalId === "4242" ? "Dune Collection" : null,
    }),
    getCollection: async () => ({
      tmdbId: 999, name: "Dune Collection", overview: "a collection", images: [{ coverType: "poster", url: "/c.jpg" }],
      parts: [
        { tmdbId: 1001, title: "Part One", releaseDate: "2021-01-01", images: [] },
        { tmdbId: 1002, title: "Part Two", releaseDate: "2024-01-01", images: [] },
        { tmdbId: 1003, title: "Part Three", releaseDate: "2026-01-01", images: [] },
      ],
    }),
    tvdbIdForTmdb: async () => "234567",
    tmdbIdForTvdb: async () => "234567",
    seriesSeasons: async () => [],
  } as unknown as TmdbProvider;
}

async function seedMovie(db: Awaited<ReturnType<typeof freshDb>>, id: string, tmdbId: number, over: Record<string, unknown> = {}) {
  await db.insert(schema.movie).values({
    id, tmdbId, title: `Movie ${tmdbId}`, overview: "", status: "released", releaseDate: "2020-01-01",
    monitored: true, qualityProfileId: null, rootFolderPath: "", folderName: null, minimumAvailability: "released",
    genres: [], images: [], tags: [], hasFile: false, addedAt: now(), updatedAt: now(), ...over,
  });
}

async function make() {
  const db = await freshDb();
  const config = new ConfigService(db);
  const movies = new MoviesService(db, new EventsService(new EventBus()), new AutoTagsService(db));
  const series = new SeriesService(db, new EventsService(new EventBus()), new AutoTagsService(db));
  await config.upsert({ "metadata.tmdbApiKey": "test-key" });
  const metadata = new MetadataService(db, config, movies, series, new AutoTagsService(db));
  vi.spyOn(metadata, "provider").mockResolvedValue(stubProvider());
  const svc = new CollectionsService(db, metadata, movies);
  return { db, svc, metadata, movies };
}

describe("CollectionsService (UNI-021)", () => {
  it("refreshing a movie that belongs to a TMDB collection creates an unmonitored collection row with populated parts", async () => {
    const { db, metadata } = await make();
    await seedMovie(db, "m1", 4242);
    await metadata.refreshMovie("m1");

    const col = (await db.select().from(schema.collection))[0];
    expect(col).toBeTruthy();
    expect(col.tmdbId).toBe(999);
    expect(col.name).toBe("Dune Collection");
    expect(col.monitored).toBe(false); // decision 1: new rows start unmonitored
    expect((col.parts ?? []).length).toBe(3);
    // no owned movies yet -> every part not in library
    expect((col.parts ?? []).every((p) => p.inLibrary === false)).toBe(true);
  });

  it("sync() recomputes inLibrary/missing-count against real library rows", async () => {
    const { db, metadata, svc } = await make();
    await seedMovie(db, "m1", 4242);
    await metadata.refreshMovie("m1"); // creates collection 999 with parts
    // Now own part 1001 (a movie with that tmdbId is in the library).
    await seedMovie(db, "mp1", 1001, { monitored: false });

    const colBefore = (await db.select().from(schema.collection))[0];
    await svc.sync(colBefore.id);
    const col = (await db.select().from(schema.collection).where(eq(schema.collection.id, colBefore.id)))[0];
    const owned = (col.parts ?? []).find((p: CollectionPart) => p.tmdbId === 1001);
    expect(owned?.inLibrary).toBe(true);
    expect(owned?.libraryId).toBe("mp1");
    expect((col.parts ?? []).filter((p) => p.inLibrary).length).toBe(1);

    const listed = await svc.list();
    expect(listed[0].missingCount).toBe(2); // 3 parts, 1 owned
  });

  it("turning Monitor ON marks already-owned movies monitored immediately; OFF never unmonitors", async () => {
    const { db, svc } = await make();
    await seedMovie(db, "mp1", 1001, { monitored: false });
    const colId = "col1";
    await db.insert(schema.collection).values({
      id: colId, tmdbId: 999, name: "C", overview: null, images: [], monitored: false, qualityProfileId: null,
      rootFolderPath: "/data/movies", minimumAvailability: "released", searchOnAdd: false,
      parts: [{ tmdbId: 1001, title: "Part One", releaseDate: null, images: [], inLibrary: true, libraryId: "mp1" }],
      createdAt: now(), updatedAt: now(),
    });

    await svc.update(colId, { monitored: true });
    const m = (await db.select().from(schema.movie).where(eq(schema.movie.id, "mp1")))[0];
    expect(m.monitored).toBe(true); // turned on right now, not deferred to a sync

    await svc.update(colId, { monitored: false });
    const m2 = (await db.select().from(schema.movie).where(eq(schema.movie.id, "mp1")))[0];
    expect(m2.monitored).toBe(true); // OFF only stops future auto-add — never unmonitors owned
  });

  it("bulk-edit applies only touched fields (No Change omission) and aggregates per-id failures", async () => {
    const { db, svc } = await make();
    const nows = now();
    await db.insert(schema.collection).values([
      { id: "col1", tmdbId: 1, name: "A", monitored: false, qualityProfileId: null, rootFolderPath: "/a", minimumAvailability: "released", searchOnAdd: false, parts: [], createdAt: nows, updatedAt: nows },
      { id: "col2", tmdbId: 2, name: "B", monitored: false, qualityProfileId: null, rootFolderPath: "/b", minimumAvailability: "released", searchOnAdd: false, parts: [], createdAt: nows, updatedAt: nows },
    ]);

    const res = await svc.bulkEdit(["col1", "col2", "bad"], { monitored: true });
    expect(res.updated.sort()).toEqual(["col1", "col2"]);
    expect(res.failed).toEqual([{ id: "bad", error: expect.any(String) }]);

    const c1 = (await db.select().from(schema.collection).where(eq(schema.collection.id, "col1")))[0];
    expect(c1.monitored).toBe(true); // touched
    expect(c1.rootFolderPath).toBe("/a"); // untouched — No Change omission
    expect(c1.minimumAvailability).toBe("released");
  });

  it("sync honors import_exclusion: an excluded missing part is never re-added", async () => {
    const { db, svc } = await make();
    // 1002 is excluded by the user; the other two missing parts are not.
    await db.insert(schema.importExclusion).values({ id: "e1", mediaType: "movie", externalId: "1002", reason: null, createdAt: now() });
    const colId = "col1";
    await db.insert(schema.collection).values({
      id: colId, tmdbId: 999, name: "C", overview: null, images: [], monitored: true, qualityProfileId: null,
      rootFolderPath: "", minimumAvailability: "released", searchOnAdd: false, parts: [], createdAt: now(), updatedAt: now(),
    });

    const r = await svc.sync(colId);
    expect(r.added).toBeGreaterThan(0);
    const added = (await db.select({ tmdbId: schema.movie.tmdbId }).from(schema.movie)).map((m) => m.tmdbId);
    expect(added).toEqual(expect.arrayContaining([1001, 1003]));
    expect(added).not.toContain(1002); // excluded -> never re-added
  });

  it("sync auto-adds parts with the collection's minimumAvailability (override beats the TMDB-date default)", async () => {
    const { db, svc } = await make();
    const colId = "col-ma";
    // The stub's releaseDate is in the past, so the computed default would be "announced" —
    // "in_cinemas" can only come from the collection's field actually being consumed.
    await db.insert(schema.collection).values({
      id: colId, tmdbId: 999, name: "C", overview: null, images: [], monitored: true, qualityProfileId: null,
      rootFolderPath: "", minimumAvailability: "in_cinemas", searchOnAdd: false, parts: [], createdAt: now(), updatedAt: now(),
    });

    await svc.sync(colId);
    const added = await db.select().from(schema.movie);
    expect(added.length).toBeGreaterThan(0);
    for (const m of added) expect(m.minimumAvailability).toBe("in_cinemas");
  });
});
