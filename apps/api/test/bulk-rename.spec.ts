// SPDX-License-Identifier: MIT
/**
 * UNI-027 — bulk Rename Files. Proves the REAL disk+relativePath effects, not just a 200:
 *  - a title whose file needs renaming gets the actual file moved and its relativePath updated
 *  - an already-correctly-named title's file is a clean no-op (not counted, not an error)
 *  - a bad title id lands in `failed` without aborting the other two
 */
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { EventBus } from "@medianexus/events";
import { createDb, schema } from "@medianexus/database";
import { ConfigService } from "../src/system/config.service";
import { EventsService } from "../src/events/events.service";
import { AutoTagsService } from "../src/auto-tags/auto-tags.service";
import { MoviesService } from "../src/movies/movies.service";

const dir = mkdtempSync(join(tmpdir(), "mn-bulkrename-"));
const handles: { close: () => void }[] = [];
const cleaned: string[] = [];
afterAll(() => {
  for (const h of handles) h.close();
  for (const d of cleaned) rmSync(d, { recursive: true, force: true });
});

async function makeServices() {
  const handle = createDb(join(dir, `br-${handles.length}.db`));
  handle.runMigrations();
  handles.push(handle);
  const db = handle.db;
  const config = new ConfigService(db);
  const movies = new MoviesService(db, new EventsService(new EventBus()), new AutoTagsService(db), config);
  return { db, movies };
}

const QUALITY = { source: "bluray", resolution: "1080p", edition: "" };
const now = () => new Date().toISOString();

async function seedMovie(db: Awaited<ReturnType<typeof makeServices>>["db"], over: Record<string, unknown>) {
  const base = {
    id: "m", tmdbId: 1, imdbId: null, title: "Fight Club", originalTitle: null, overview: "",
    status: "released", releaseDate: "1999-10-15", monitored: true, qualityProfileId: null,
    rootFolderPath: "", minimumAvailability: "released", genres: [], images: [], tags: [],
    hasFile: true, addedAt: now(), updatedAt: now(),
  };
  await db.insert(schema.movie).values({ ...base, ...over });
}

function mediaFile(id: string, mediaId: string, relativePath: string): typeof schema.mediaFile.$inferInsert {
  return { id, mediaType: "movie", mediaId, relativePath, size: 1000, quality: QUALITY, dateAdded: now() };
}

describe("MoviesService.bulkRename (UNI-027)", () => {
  it("moves files that need renaming on disk + updates relativePath, no-ops correct files, and isolates a bad id", async () => {
    const { db, movies } = await makeServices();
    const root = mkdtempSync(join(tmpdir(), "mn-br-files-"));
    cleaned.push(root);

    // m1: "Fight Club (1999)" — file is mis-named (old-name.mkv) and must be renamed.
    await seedMovie(db, { id: "m1", tmdbId: 1, title: "Fight Club", releaseDate: "1999-10-15", rootFolderPath: root });
    // m2: "Inception (2010)" — file is already correctly named; bulk rename must no-op it.
    await seedMovie(db, { id: "m2", tmdbId: 2, title: "Inception", releaseDate: "2010-07-16", rootFolderPath: root });

    // Create real files on disk as the DB rows claim.
    mkdirSync(join(root, "Fight Club (1999)"), { recursive: true });
    mkdirSync(join(root, "Inception (2010)"), { recursive: true });
    const oldFile = join(root, "Fight Club (1999)/old-name.mkv");
    const correctFile = join(root, "Inception (2010)/Inception (2010).mkv");
    writeFileSync(oldFile, "x");
    writeFileSync(correctFile, "x");

    await db.insert(schema.mediaFile).values([
      mediaFile("mf_m1", "m1", "Fight Club (1999)/old-name.mkv"),
      mediaFile("mf_m2", "m2", "Inception (2010)/Inception (2010).mkv"),
    ]);
    // Give m1's file a quality-encoded name mismatch so the default template makes it a rename.
    // (Default movie template is "{Movie Title} ({Release Year})" and the file IS the wrong name.)

    const res = await movies.bulkRename(["m1", "m2", "nope"]);

    // m2's already-correct file not counted, no error.
    expect(res.titlesProcessed).toBe(2);
    expect(res.filesRenamed).toBe(1);
    expect(res.failed).toEqual([{ id: "nope", error: expect.any(String) }]);

    // m1's file was physically moved and its relativePath updated.
    const renamedPath = join(root, "Fight Club (1999)/Fight Club (1999).mkv");
    expect(existsSync(renamedPath)).toBe(true);
    expect(existsSync(oldFile)).toBe(false);
    const mf = (await db.select().from(schema.mediaFile).where(eq(schema.mediaFile.id, "mf_m1")))[0];
    expect(mf.relativePath).toBe("Fight Club (1999)/Fight Club (1999).mkv");

    // m2's correctly-named file untouched on disk and unchanged in DB.
    expect(existsSync(correctFile)).toBe(true);
    const mf2 = (await db.select().from(schema.mediaFile).where(eq(schema.mediaFile.id, "mf_m2")))[0];
    expect(mf2.relativePath).toBe("Inception (2010)/Inception (2010).mkv");

    // m1 movie row still exists (bulk rename is not a delete, obviously).
    expect((await db.select().from(schema.movie).where(eq(schema.movie.id, "m1"))).length).toBe(1);
  });
});
