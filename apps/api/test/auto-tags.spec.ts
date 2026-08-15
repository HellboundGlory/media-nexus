// SPDX-License-Identifier: MIT
/**
 * Roadmap P3 (gap report C6) — auto-tag wiring. Proves the real service wiring fires on
 * create/update/refresh by seeding an auto_tag rule and asserting the resulting row's tags change
 * through the actual DB path (not the pure domain function in isolation).
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@medianexus/database";
import { ConfigService } from "../src/system/config.service";
import { EventsService } from "../src/events/events.service";
import { EventBus } from "@medianexus/events";
import { AutoTagsService } from "../src/auto-tags/auto-tags.service";
import { MoviesService } from "../src/movies/movies.service";
import { SeriesService } from "../src/series/series.service";
import { MetadataService } from "../src/metadata/metadata.service";

const dir = mkdtempSync(join(tmpdir(), "mn-autotag-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });

let counter = 0;
async function freshDb() {
  const handle = createDb(join(dir, `at-${counter++}.db`));
  handle.runMigrations();
  handles.push(handle);
  return handle.db;
}

async function seedAutoTagRule(db: Awaited<ReturnType<typeof freshDb>>, over: Partial<typeof schema.autoTag.$inferInsert> = {}) {
  const now = new Date().toISOString();
  await db.insert(schema.autoTag).values({
    id: "at1", name: "R", removeTagsAutomatically: false, tags: [], specifications: [],
    createdAt: now, updatedAt: now, ...over,
  });
}

async function seedMovie(db: Awaited<ReturnType<typeof freshDb>>, over: Partial<typeof schema.movie.$inferInsert> = {}) {
  const now = new Date().toISOString();
  await db.insert(schema.movie).values({
    id: "m1", tmdbId: 1, title: "Some Movie", overview: "", status: "released", releaseDate: "2020-01-01",
    monitored: true, qualityProfileId: null, rootFolderPath: "", minimumAvailability: "announced",
    genres: [], images: [], tags: [], hasFile: false, addedAt: now, updatedAt: now, ...over,
  });
}

function services(db: Awaited<ReturnType<typeof freshDb>>) {
  const autoTags = new AutoTagsService(db);
  const events = new EventsService(new EventBus());
  const movies = new MoviesService(db, events, autoTags);
  const series = new SeriesService(db, events, autoTags);
  return { autoTags, events, movies, series };
}

/** MetadataService with a stubbed provider so refreshMovie/refreshSeries run without real TMDB. */
class StubMetadataService extends MetadataService {
  constructor(
    db: Awaited<ReturnType<typeof freshDb>>,
    private readonly fake: Awaited<ReturnType<MetadataService["provider"]>>,
  ) {
    const s = services(db);
    super(db, new ConfigService(db), s.movies, s.series, s.autoTags);
  }
  override async provider() { return this.fake; }
}

describe("auto-tag wiring — create", () => {
  it("applies a matching rule's tag to a newly created movie (one atomic insert)", async () => {
    const db = await freshDb();
    await seedAutoTagRule(db, { specifications: [{ type: "monitored", value: true, negate: false, required: false }], tags: ["auto-mon"] });
    const { movies } = services(db);

    const created = await movies.create({ title: "New", minimumAvailability: "announced", releaseDate: "2021-05-05" });
    expect(created.tags).toContain("auto-mon");
    const row = await db.select({ tags: schema.movie.tags }).from(schema.movie).where(eq(schema.movie.id, created.id));
    expect(row[0]?.tags).toContain("auto-mon");
  });
});

describe("auto-tag wiring — update", () => {
  it("applies a rule's tag when an edit makes the rule match (root folder rule)", async () => {
    const db = await freshDb();
    await seedMovie(db, { rootFolderPath: "" });
    await seedAutoTagRule(db, { specifications: [{ type: "rootFolder", value: "/movies", negate: false, required: false }], tags: ["folder-tag"] });
    const { movies } = services(db);

    await movies.update("m1", { rootFolderPath: "/movies" });
    const row = await db.select({ tags: schema.movie.tags }).from(schema.movie).where(eq(schema.movie.id, "m1"));
    expect(row[0]?.tags).toContain("folder-tag");
  });

  it("removes a rule's tags when the rule stops matching and removeTagsAutomatically is on", async () => {
    const db = await freshDb();
    await seedMovie(db, { rootFolderPath: "/movies", tags: ["folder-tag"] });
    await seedAutoTagRule(db, {
      removeTagsAutomatically: true,
      specifications: [{ type: "rootFolder", value: "/movies", negate: false, required: false }],
      tags: ["folder-tag"],
    });
    const { movies } = services(db);

    await movies.update("m1", { rootFolderPath: "" });
    const row = await db.select({ tags: schema.movie.tags }).from(schema.movie).where(eq(schema.movie.id, "m1"));
    expect(row[0]?.tags).not.toContain("folder-tag");
  });
});

describe("auto-tag wiring — metadata refresh", () => {
  it("applies a genre rule's tag when refresh populates genres on a movie", async () => {
    const db = await freshDb();
    await seedMovie(db, { genres: [] });
    await seedAutoTagRule(db, { specifications: [{ type: "genre", value: "Comedy", negate: false, required: false }], tags: ["comedy-tag"] });

    const fake = {
      getDetails: async () => ({ genres: ["Comedy"], images: [], overview: "desc", releaseDate: "2020-01-01" }),
    };
    const metadata = new StubMetadataService(db, fake as never);
    await metadata.refreshMovie("m1");

    const row = await db.select({ tags: schema.movie.tags }).from(schema.movie).where(eq(schema.movie.id, "m1"));
    expect(row[0]?.tags).toContain("comedy-tag");
  });
});
