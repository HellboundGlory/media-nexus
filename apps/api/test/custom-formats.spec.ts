// SPDX-License-Identifier: MIT
/**
 * Roadmap P2 (gap report B4/D6): custom-format CRUD + decision-engine integration, end to
 * end from real `custom_format` / `quality_profile` rows. The pure scoring core is unit-
 * tested in packages/domain/src/custom-formats.test.ts; these tests cover what the API
 * layer actually feeds the engine: a real grab decision where format score flips the
 * outcome, an upgrade triggered purely by format score, and the CRUD surface.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, schema } from "@medianexus/database";
import { qualityId, type Release, type CustomFormatSpec } from "@medianexus/domain";
import { DecisionService } from "../src/decision/decision.service";
import { MediaRepository } from "../src/media/media.repository";
import { BlocklistService } from "../src/blocklist/blocklist.service";
import { ConfigService } from "../src/system/config.service";
import { RootFoldersService } from "../src/root-folders/root-folders.service";
import { CustomFormatsService } from "../src/custom-formats/custom-formats.service";

const dir = mkdtempSync(join(tmpdir(), "mn-custom-formats-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });

let counter = 0;
async function freshDb() {
  const handle = createDb(join(dir, `cf-${counter++}.db`));
  handle.runMigrations();
  handles.push(handle);
  return handle.db;
}

function release(over: Partial<Release> = {}): Release {
  return {
    id: "r1", indexerId: "idx1", indexerName: "Demo", title: "Some.Movie.2020.1080p.WEB-DL",
    protocol: "torrent", categories: [], size: 1000, ageHours: 1, seeders: 10, leechers: 1,
    quality: { source: "web", resolution: "1080p", edition: "" },
    isFreeleech: false, isProper: false, isRepack: false,
    ...over,
  };
}

type Db = Awaited<ReturnType<typeof freshDb>>;

async function seedMovie(db: Db, over: Partial<typeof schema.movie.$inferInsert> = {}) {
  const now = new Date().toISOString();
  await db.insert(schema.movie).values({
    id: "m1", tmdbId: 1, title: "Some Movie", overview: "", status: "released", releaseDate: "2020-01-01",
    monitored: true, qualityProfileId: null, rootFolderPath: "", minimumAvailability: "announced",
    genres: [], images: [], tags: [], hasFile: false, addedAt: now, updatedAt: now,
    ...over,
  });
}

const X265_SPEC: CustomFormatSpec = { type: "term", term: "x265", useRegex: false, negate: false, caseSensitive: false };

function decisionService(db: Db) {
  return new DecisionService(db, new MediaRepository(db), new BlocklistService(db), new ConfigService(db), new RootFoldersService(db, new ConfigService(db)));
}

describe("custom-format CRUD (CustomFormatsService)", () => {
  it("creates, reads, updates and removes a custom format", async () => {
    const db = await freshDb();
    const svc = new CustomFormatsService(db);

    const created = await svc.create({ name: "x265", specs: [X265_SPEC] });
    expect(created.id).toBeTruthy();
    expect(created.name).toBe("x265");

    const got = await svc.get(created.id);
    expect(got.specs).toEqual([X265_SPEC]);

    const updated = await svc.update(created.id, { specs: [{ ...X265_SPEC, term: "x265-hdr" }] });
    expect(updated.specs).toEqual([{ ...X265_SPEC, term: "x265-hdr" }]);

    expect((await svc.list()).map((f) => f.id)).toContain(created.id);
    await svc.remove(created.id);
    await expect(svc.get(created.id)).rejects.toThrow();
  });
});

describe("DecisionService — minFormatScore gate changes the grab outcome", () => {
  it("rejects a release below the profile minimum, then grabs one above it", async () => {
    const db = await freshDb();
    const f1 = await new CustomFormatsService(db).create({ name: "x265", specs: [X265_SPEC] });
    const now = new Date().toISOString();
    await db.insert(schema.qualityProfile).values({
      id: "qp1", name: "Test", items: [qualityId({ source: "web", resolution: "1080p", edition: "" } as never)],
      cutoffQualityId: qualityId({ source: "web", resolution: "1080p", edition: "" } as never),
      upgradeAllowed: true, language: "en", isDefault: true,
      formatScores: { [f1.id]: 100 }, minFormatScore: 50, cutoffFormatScore: 0,
      createdAt: now, updatedAt: now,
    });
    await seedMovie(db, { qualityProfileId: "qp1" });
    const svc = decisionService(db);

    const rejected = await svc.evaluate("movie", "m1", release({ title: "Some.Movie.2020.1080p.WEB-DL" }));
    expect(rejected.approved).toBe(false);
    expect(rejected.formatScore).toBe(0);
    expect(rejected.rejections.map((r) => r.reason)).toContain("below_min_format_score");
    // No x265 in the title -> no matched formats (SON-024)
    expect(rejected.matchedFormats).toEqual([]);

    const grabbed = await svc.evaluate("movie", "m1", release({ title: "Some.Movie.2020.1080p.x265" }));
    expect(grabbed.approved).toBe(true);
    expect(grabbed.formatScore).toBe(100);
    // x265 matches -> the id+name subset appears on the decision (SON-024)
    expect(grabbed.matchedFormats.map((m) => m.id)).toContain(f1.id);
    expect(grabbed.matchedFormats.map((m) => m.name)).toContain("x265");
  });
});

describe("DecisionService — upgrade triggered purely by format score", () => {
  it("upgrades a same-quality release when only the format score improves, below format cutoff", async () => {
    const db = await freshDb();
    const f1 = await new CustomFormatsService(db).create({ name: "x265", specs: [X265_SPEC] });
    const now = new Date().toISOString();
    const qid = qualityId({ source: "web", resolution: "1080p", edition: "" } as never);
    await db.insert(schema.qualityProfile).values({
      id: "qp1", name: "Test", items: [qid], cutoffQualityId: qid,
      upgradeAllowed: true, language: "en", isDefault: true,
      formatScores: { [f1.id]: 100 }, minFormatScore: 0, cutoffFormatScore: 50,
      createdAt: now, updatedAt: now,
    });
    await seedMovie(db, { qualityProfileId: "qp1" });
    // existing file already meets the QUALITY cutoff; only its format score (0) is below
    await db.insert(schema.mediaFile).values({
      id: "mf1", mediaType: "movie", mediaId: "m1", episodeIds: [], relativePath: "Some.Movie.mkv",
      size: 1000, quality: { source: "web", resolution: "1080p", edition: "" }, dateAdded: now,
    });
    const svc = decisionService(db);

    const d = await svc.evaluate("movie", "m1", release({ title: "Some.Movie.2020.1080p.x265" }));
    expect(d.approved).toBe(true);
    expect(d.formatScore).toBe(100);
    expect(d.rejections.map((r) => r.reason)).not.toContain("cutoff_already_met");
  });
});
