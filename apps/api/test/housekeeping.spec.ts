// SPDX-License-Identifier: MIT
/**
 * Roadmap P1 (gap report B9): orphan sweep over the 5 polymorphic tables + retention
 * trims for job_run/audit_log/terminal download_queue_entry/blocklist_entry. Orphan sweep
 * is defense-in-depth (MoviesService.remove()/SeriesService.remove() already cascade these
 * transactionally, roadmap P0.7) — these tests seed rows directly to simulate data that
 * predates that cascade, or a bypassed one.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, schema } from "@medianexus/database";
import { HousekeepingService } from "../src/system/housekeeping.service";
import { ConfigService } from "../src/system/config.service";

const dir = mkdtempSync(join(tmpdir(), "mn-housekeeping-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });

let counter = 0;
async function freshDb() {
  const handle = createDb(join(dir, `hk-${counter++}.db`));
  handle.runMigrations();
  handles.push(handle);
  return handle.db;
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

describe("HousekeepingService — orphan sweep", () => {
  it("removes polymorphic rows whose (mediaType, mediaId) no longer exists, leaves rows for a real movie alone", async () => {
    const db = await freshDb();
    await db.insert(schema.movie).values({
      id: "m1", tmdbId: 1, title: "Real Movie", releaseDate: "2020-01-01", status: "released",
      minimumAvailability: "released", monitored: true, qualityProfileId: null, rootFolderPath: "",
      images: [], tags: [], hasFile: false, addedAt: daysAgo(1), updatedAt: daysAgo(1),
    } as never);

    await db.insert(schema.mediaFile).values([
      { id: "mf1", mediaType: "movie", mediaId: "m1", relativePath: "real.mkv", size: 1, dateAdded: daysAgo(1) },
      { id: "mf2", mediaType: "movie", mediaId: "gone", relativePath: "orphan.mkv", size: 1, dateAdded: daysAgo(1) },
      { id: "mf3", mediaType: "series", mediaId: "also-gone", relativePath: "orphan2.mkv", size: 1, dateAdded: daysAgo(1) },
    ] as never);
    await db.insert(schema.blocklistEntry).values([
      { id: "bl1", mediaType: "movie", mediaId: "m1", title: "kept", createdAt: daysAgo(1) },
      { id: "bl2", mediaType: "movie", mediaId: "gone", title: "orphan", createdAt: daysAgo(1) },
    ] as never);

    const svc = new HousekeepingService(db, new ConfigService(db));
    const summary = await svc.run();

    expect(summary.orphansRemoved.mediaFile).toBe(2);
    expect(summary.orphansRemoved.blocklistEntry).toBe(1);
    const remainingFiles = await db.select().from(schema.mediaFile);
    expect(remainingFiles.map((r) => r.id)).toEqual(["mf1"]);
    const remainingBlocklist = await db.select().from(schema.blocklistEntry);
    expect(remainingBlocklist.map((r) => r.id)).toEqual(["bl1"]);
  });

  it("treats every row as orphaned when no movies/series exist at all", async () => {
    const db = await freshDb();
    await db.insert(schema.mediaFile).values([
      { id: "mf1", mediaType: "movie", mediaId: "x", relativePath: "a.mkv", size: 1, dateAdded: daysAgo(1) },
    ] as never);
    const svc = new HousekeepingService(db, new ConfigService(db));
    const summary = await svc.run();
    expect(summary.orphansRemoved.mediaFile).toBe(1);
  });
});

describe("HousekeepingService — retention trims", () => {
  it("trims terminal job_run rows past the retention window, leaves recent and non-terminal ones", async () => {
    const db = await freshDb();
    await db.insert(schema.jobRun).values([
      { id: "jr-old", jobKey: "x", status: "succeeded", createdAt: daysAgo(40) },
      { id: "jr-recent", jobKey: "x", status: "succeeded", createdAt: daysAgo(1) },
      { id: "jr-old-running", jobKey: "x", status: "running", createdAt: daysAgo(40) },
    ] as never);
    const svc = new HousekeepingService(db, new ConfigService(db));
    const summary = await svc.run();
    expect(summary.jobRunsTrimmed).toBe(1);
    const remaining = (await db.select().from(schema.jobRun)).map((r) => r.id).sort();
    expect(remaining).toEqual(["jr-old-running", "jr-recent"]);
  });

  it("trims audit_log rows past the retention window", async () => {
    const db = await freshDb();
    await db.insert(schema.auditLog).values([
      { id: "al-old", actor: "system", action: "x", createdAt: daysAgo(100) },
      { id: "al-recent", actor: "system", action: "x", createdAt: daysAgo(1) },
    ] as never);
    const svc = new HousekeepingService(db, new ConfigService(db));
    const summary = await svc.run();
    expect(summary.auditLogTrimmed).toBe(1);
  });

  it("trims terminal download_queue_entry rows past the retention window, leaves active ones", async () => {
    const db = await freshDb();
    await db.insert(schema.movie).values({
      id: "z", tmdbId: 2, title: "Movie Z", releaseDate: "2020-01-01", status: "released",
      minimumAvailability: "released", monitored: true, qualityProfileId: null, rootFolderPath: "",
      images: [], tags: [], hasFile: false, addedAt: daysAgo(1), updatedAt: daysAgo(1),
    } as never);
    await db.insert(schema.downloadQueueEntry).values([
      { id: "q-old-imported", mediaType: "movie", mediaId: "z", title: "x", status: "imported", addedAt: daysAgo(30), updatedAt: daysAgo(30) },
      { id: "q-recent-imported", mediaType: "movie", mediaId: "z", title: "x", status: "imported", addedAt: daysAgo(1), updatedAt: daysAgo(1) },
      { id: "q-old-downloading", mediaType: "movie", mediaId: "z", title: "x", status: "downloading", addedAt: daysAgo(30), updatedAt: daysAgo(30) },
    ] as never);
    const svc = new HousekeepingService(db, new ConfigService(db));
    const summary = await svc.run();
    expect(summary.queueEntriesTrimmed).toBe(1);
    const remaining = (await db.select().from(schema.downloadQueueEntry)).map((r) => r.id).sort();
    expect(remaining).toEqual(["q-old-downloading", "q-recent-imported"]);
  });

  it("trims blocklist_entry rows past the retention window", async () => {
    const db = await freshDb();
    await db.insert(schema.movie).values({
      id: "z", tmdbId: 2, title: "Movie Z", releaseDate: "2020-01-01", status: "released",
      minimumAvailability: "released", monitored: true, qualityProfileId: null, rootFolderPath: "",
      images: [], tags: [], hasFile: false, addedAt: daysAgo(1), updatedAt: daysAgo(1),
    } as never);
    await db.insert(schema.blocklistEntry).values([
      { id: "bl-old", mediaType: "movie", mediaId: "z", title: "x", createdAt: daysAgo(60) },
      { id: "bl-recent", mediaType: "movie", mediaId: "z", title: "x", createdAt: daysAgo(1) },
    ] as never);
    const svc = new HousekeepingService(db, new ConfigService(db));
    const summary = await svc.run();
    expect(summary.blocklistTrimmed).toBe(1);
  });
});
