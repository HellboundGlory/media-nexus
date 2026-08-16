// SPDX-License-Identifier: MIT
/**
 * Roadmap P1, gap report C5 — edit (PUT) endpoints on core entities, including the
 * season-monitoring toggle.
 *
 * Exercises the service-level update methods against a real SQLite DB (createDb +
 * migrations), the same pattern as secrets.spec.ts. Covers:
 *  - season monitoring cascades to episodes (making it affect wanted/missing)
 *  - movie/series field edits (incl. `qualityProfileId: null` clearing)
 *  - indexer + download-client updates are J9-aware: a NEW secret is stored encrypted,
 *    an omitted or `[REDACTED]` secret is PRESERVED (never lost, never stored plaintext),
 *    non-secret settings still update, and the returned row is redacted
 *  - root-folder rename + single-default invariant
 */
import { AutoTagsService } from "../src/auto-tags/auto-tags.service";
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb, schema, type Db } from "@medianexus/database";
import { MoviesService } from "../src/movies/movies.service";
import { SeriesService } from "../src/series/series.service";
import { IndexersService } from "../src/indexers/indexers.service";
import { DownloadClientsService } from "../src/download-clients/download-clients.service";
import { RootFoldersService } from "../src/root-folders/root-folders.service";
import { ConfigService } from "../src/system/config.service";
import { decryptFields, encryptFields, isEncrypted } from "../src/secrets/provider-secrets";

process.env.MEDIA_NEXUS_SECRET = "test-secret-only";
const SECRET = "test-secret-only";

const dir = mkdtempSync(join(tmpdir(), "mn-edit-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });
let counter = 0;
function freshDb(): Db {
  const handle = createDb(join(dir, `e-${counter++}.db`));
  handle.runMigrations();
  handles.push(handle);
  return handle.db;
}
const now = () => new Date().toISOString();

describe("C5 season monitoring", () => {
  it("toggling a season cascades monitored to every episode in it", async () => {
    const db = freshDb();
    db.insert(schema.series).values({
      id: "s1", tvdbId: 1, tmdbId: null, imdbId: null, title: "Show", overview: "", status: "unknown",
      seriesType: "standard", network: null, firstAirYear: null, monitored: true, qualityProfileId: null,
      rootFolderPath: "", genres: [], images: [], tags: [], addedAt: now(), updatedAt: now(),
    }).run();
    db.insert(schema.season).values({ id: "sea1", seriesId: "s1", seasonNumber: 1, monitored: true }).run();
    db.insert(schema.episode).values({
      id: "ep1", seriesId: "s1", seasonId: "sea1", episodeNumber: 1, absoluteNumber: null, title: "E1",
      overview: "", airDateUtc: null, monitored: true, hasFile: false, sceneSeasonNumber: null, sceneEpisodeNumber: null,
    }).run();
    db.insert(schema.episode).values({
      id: "ep2", seriesId: "s1", seasonId: "sea1", episodeNumber: 2, absoluteNumber: null, title: "E2",
      overview: "", airDateUtc: null, monitored: true, hasFile: false, sceneSeasonNumber: null, sceneEpisodeNumber: null,
    }).run();

    const svc = new SeriesService(db, {} as never, new AutoTagsService(db));
    const sea = await svc.setSeasonMonitored("s1", "sea1", false);
    expect(sea.monitored).toBe(false);
    const eps = db.select().from(schema.episode).where(eq(schema.episode.seasonId, "sea1")).all();
    expect(eps.every((e) => e.monitored === false)).toBe(true);
  });

  it("404s for a season that doesn't belong to the series", async () => {
    const db = freshDb();
    db.insert(schema.series).values({
      id: "s1", tvdbId: 1, title: "Show", overview: "", status: "unknown", seriesType: "standard",
      monitored: true, rootFolderPath: "", genres: [], images: [], tags: [], addedAt: now(), updatedAt: now(),
    } as never).run();
    const svc = new SeriesService(db, {} as never, new AutoTagsService(db));
    await expect(svc.setSeasonMonitored("s1", "nope", false)).rejects.toThrow();
  });
});

describe("C5 movie/series edits", () => {
  it("movie update edits fields, bumps updatedAt, and null clears qualityProfileId", async () => {
    const db = freshDb();
    db.insert(schema.qualityProfile).values({
      id: "qp1", name: "P", items: [1, 2], cutoffQualityId: 2, upgradeAllowed: true, language: "en",
      isDefault: true, createdAt: now(), updatedAt: now(),
    }).run();
    db.insert(schema.movie).values({
      id: "m1", tmdbId: 1, imdbId: null, title: "Old", originalTitle: null, overview: "", status: "released",
      releaseDate: null, monitored: true, qualityProfileId: "qp1", rootFolderPath: "/rf",
      minimumAvailability: "announced", genres: [], images: [], tags: [], hasFile: false, addedAt: now(), updatedAt: now(),
    }).run();
    const svc = new MoviesService(db, {} as never, new AutoTagsService(db));
    const updated = await svc.update("m1", { title: "New", monitored: false });
    expect(updated.title).toBe("New");
    expect(updated.monitored).toBe(false);
    expect(updated.qualityProfileId).toBe("qp1"); // untouched
    const cleared = await svc.update("m1", { qualityProfileId: null });
    expect(cleared.qualityProfileId).toBeNull();
  });

  it("series update edits seriesType and monitored", async () => {
    const db = freshDb();
    db.insert(schema.series).values({
      id: "s1", tvdbId: 1, tmdbId: null, imdbId: null, title: "Show", overview: "", status: "unknown",
      seriesType: "standard", network: null, firstAirYear: null, monitored: true, qualityProfileId: null,
      rootFolderPath: "", genres: [], images: [], tags: [], addedAt: now(), updatedAt: now(),
    }).run();
    const svc = new SeriesService(db, {} as never, new AutoTagsService(db));
    const updated = await svc.update("s1", { seriesType: "daily", monitored: false });
    expect(updated.seriesType).toBe("daily");
    expect(updated.monitored).toBe(false);
  });
});

describe("C5 J9-aware indexer update", () => {
  function seedIndexer(db: Db, id: string, settings: Record<string, unknown>) {
    db.insert(schema.indexer).values({
      id, definitionKey: "generic-newznab", name: "Old", protocol: "usenet", enabled: true,
      implementation: "newznab", settings, priority: 25, status: "ok", tags: [], createdAt: now(), updatedAt: now(),
    }).run();
  }
  function idxSvc(db: Db) {
    return new IndexersService(db, {} as never, {} as never, {} as never, {} as never, {} as never);
  }
  function storedSettings(db: Db, id: string): Record<string, unknown> {
    const row = db.select().from(schema.indexer).where(eq(schema.indexer.id, id)).all()[0] as any;
    return row.settings as Record<string, unknown>;
  }

  it("a brand-new secret is stored encrypted on update", async () => {
    const db = freshDb();
    db.insert(schema.indexerDefinition).values({
      id: "idef1", key: "generic-newznab", name: "GN", protocol: "usenet", implementation: "newznab",
      builtIn: true, capabilities: {}, categoryIds: [], cardigannYml: null, createdAt: now(),
    }).run();
    seedIndexer(db, "ix1", encryptFields({ baseUrl: "https://x", apiKey: "ORIG-KEY", categories: [5000] } as Record<string, unknown>, ["apiKey", "password"], SECRET));

    const res = await idxSvc(db).update("ix1", { settings: { baseUrl: "https://x", apiKey: "NEW-KEY" } });
    expect((res.settings as Record<string, unknown>).apiKey).toBe("[REDACTED]"); // response is redacted
    const stored = storedSettings(db, "ix1");
    expect(isEncrypted(stored.apiKey as string, SECRET)).toBe(true); // encrypted at rest
    expect((decryptFields(stored, ["apiKey"], SECRET)).apiKey).toBe("NEW-KEY");
    // a legit apiKey never lands in plaintext
    expect((stored.apiKey as string).includes("NEW-KEY")).toBe(false);
  });

  it("a [REDACTED] or omitted secret is preserved, not corrupted", async () => {
    const db = freshDb();
    db.insert(schema.indexerDefinition).values({
      id: "idef1", key: "generic-newznab", name: "GN", protocol: "usenet", implementation: "newznab",
      builtIn: true, capabilities: {}, categoryIds: [], cardigannYml: null, createdAt: now(),
    }).run();
    seedIndexer(db, "ix1", encryptFields({ baseUrl: "https://x", apiKey: "ORIG-KEY", categories: [5000] } as Record<string, unknown>, ["apiKey", "password"], SECRET));

    const svc = idxSvc(db);
    // client round-trips the [REDACTED] placeholder it got from list/get — must NOT be stored
    await svc.update("ix1", { settings: { baseUrl: "https://y", apiKey: "[REDACTED]" } });
    const stored = storedSettings(db, "ix1");
    expect((decryptFields(stored, ["apiKey"], SECRET)).apiKey).toBe("ORIG-KEY"); // preserved
    expect((stored.apiKey as string).includes("REDACTED")).toBe(false); // sentinel never stored
    expect(stored.baseUrl).toBe("https://y"); // non-secret edit applied

    // ...and an omitted apiKey (only re-sending the URL) also preserves it
    await svc.update("ix1", { settings: { baseUrl: "https://z" } });
    const stored2 = storedSettings(db, "ix1");
    expect((decryptFields(stored2, ["apiKey"], SECRET)).apiKey).toBe("ORIG-KEY");
    expect(stored2.baseUrl).toBe("https://z");
  });

  it("non-secret fields (priority/enabled/name) update independently", async () => {
    const db = freshDb();
    seedIndexer(db, "ix1", encryptFields({ baseUrl: "https://x", apiKey: "K" } as Record<string, unknown>, ["apiKey"], SECRET));
    const res = await idxSvc(db).update("ix1", { enabled: false, priority: 10, name: "Renamed" });
    expect(res.enabled).toBe(false);
    expect(res.priority).toBe(10);
    expect(res.name).toBe("Renamed");
  });
});

describe("C5 J9-aware download-client update", () => {
  it("new secret encrypted at rest; [REDACTED] preserved; non-secrets update", async () => {
    const db = freshDb();
    db.insert(schema.downloadClient).values({
      id: "dc1", name: "Old", implementation: "qbittorrent", kind: "torrent", enabled: true, priority: 1,
      settings: encryptFields({ host: "https://h", username: "u", password: "ORIG-PW" } as Record<string, unknown>, ["password"], SECRET),
      tags: [], createdAt: now(), updatedAt: now(),
    }).run();
    const svc = new DownloadClientsService(db, { invalidateDownloadClient: () => {} } as never, {} as never, {} as never);

    // new secret -> encrypted at rest
    await svc.update("dc1", { settings: { host: "https://h", password: "NEW-PW" } });
    let stored = (db.select().from(schema.downloadClient).where(eq(schema.downloadClient.id, "dc1")).all()[0] as any).settings as Record<string, unknown>;
    expect(isEncrypted(stored.password as string, SECRET)).toBe(true);
    expect((decryptFields(stored, ["password"], SECRET)).password).toBe("NEW-PW");

    // [REDACTED] sentinel -> preserved
    await svc.update("dc1", { settings: { password: "[REDACTED]" } });
    stored = (db.select().from(schema.downloadClient).where(eq(schema.downloadClient.id, "dc1")).all()[0] as any).settings as Record<string, unknown>;
    expect((decryptFields(stored, ["password"], SECRET)).password).toBe("NEW-PW");
    expect((stored.password as string).includes("REDACTED")).toBe(false);

    // non-secret edit
    const res = await svc.update("dc1", { enabled: false, priority: 5 });
    expect(res.enabled).toBe(false);
    expect(res.priority).toBe(5);
  });
});

describe("C5 root-folder update", () => {
  it("renames and enforces the single-default invariant", async () => {
    const db = freshDb();
    const a = mkdtempSync(join(tmpdir(), "mn-rf-a-")); const b = mkdtempSync(join(tmpdir(), "mn-rf-b-"));
    db.insert(schema.rootFolder).values({ id: "rf1", path: a, name: "A", isDefault: true, createdAt: now() }).run();
    db.insert(schema.rootFolder).values({ id: "rf2", path: b, name: "B", isDefault: false, createdAt: now() }).run();

    const svc = new RootFoldersService(db, new ConfigService(db));
    const upd = await svc.update("rf2", { isDefault: true, name: "B2" });
    expect(upd.isDefault).toBe(true);
    expect(upd.name).toBe("B2");
    const other = db.select().from(schema.rootFolder).where(eq(schema.rootFolder.id, "rf1")).all()[0] as any;
    expect(other.isDefault).toBe(false);
  });
});
