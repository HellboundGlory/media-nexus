// SPDX-License-Identifier: MIT
/**
 * Roadmap P2, gap report C6 — tags as behavior.
 *
 * Covers:
 *  - the tag catalog CRUD (TagsService) on a real SQLite DB
 *  - DELETE cascade: removing a tag strips it from movie/series/indexer/download_client
 *  - the tag-applies routing rule (tagApplies)
 *  - download-client tag-routing via ProvidersService.pickDownloadClient (untagged client
 *    serves everything; tagged client only serves media sharing a tag; explicit id wins)
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb, schema, type Db } from "@medianexus/database";
import { ProviderRegistry, MemoryIndexerProvider, MemoryDownloadClientProvider } from "@medianexus/integrations";
import { TagsService } from "../src/tags/tags.service";
import { ConfigService } from "../src/system/config.service";
import { ProviderStatusService } from "../src/providers/provider-status.service";
import { ProvidersService } from "../src/providers/demo.providers";
import { tagApplies } from "../src/common/tags";

const dir = mkdtempSync(join(tmpdir(), "mn-c6-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });
let counter = 0;
function freshDb(): Db {
  const handle = createDb(join(dir, `c6-${counter++}.db`));
  handle.runMigrations();
  handles.push(handle);
  return handle.db;
}
const now = () => new Date().toISOString();

function seedMovie(db: Db, id: string, tags: string[]): void {
  db.insert(schema.movie).values({
    id, tmdbId: 1, imdbId: null, title: "M", originalTitle: null, overview: "", status: "released",
    releaseDate: null, monitored: true, qualityProfileId: null, rootFolderPath: "/m", minimumAvailability: "announced",
    genres: [], images: [], tags, hasFile: false, addedAt: now(), updatedAt: now(),
  }).run();
}
function seedSeries(db: Db, id: string, tags: string[]): void {
  db.insert(schema.series).values({
    id, tvdbId: 1, tmdbId: null, imdbId: null, title: "S", overview: "", status: "unknown", seriesType: "standard",
    network: null, firstAirYear: null, monitored: true, qualityProfileId: null, rootFolderPath: "", genres: [],
    images: [], tags, addedAt: now(), updatedAt: now(),
  }).run();
}
function seedIndexer(db: Db, id: string, tags: string[]): void {
  db.insert(schema.indexer).values({
    id, definitionKey: "generic-newznab", name: id, protocol: "usenet", enabled: true, implementation: "newznab",
    settings: {}, priority: 25, status: "ok", tags, createdAt: now(), updatedAt: now(),
  }).run();
}
function seedClient(db: Db, id: string, kind: string, priority: number, tags: string[]): void {
  db.insert(schema.downloadClient).values({
    id, name: id, implementation: "qbittorrent", kind, enabled: true, priority, settings: {}, tags, createdAt: now(), updatedAt: now(),
  }).run();
}

describe("C6 tag catalog CRUD", () => {
  it("creates, lists, updates, and deletes a tag", async () => {
    const db = freshDb();
    const svc = new TagsService(db);
    await svc.create({ id: "4k", label: "4K UHD", color: "#ff0000" });
    const listed = await svc.list();
    expect(listed.map((t) => t.id)).toEqual(["4k"]);
    const updated = await svc.update("4k", { label: "4K Remux", color: "#00ff00" });
    expect(updated.label).toBe("4K Remux");
    expect(updated.color).toBe("#00ff00");
    await expect(svc.create({ id: "4k" })).rejects.toThrow(); // conflict on duplicate
    const removed = await svc.remove("4k");
    expect(removed.removed).toBe("4k");
    expect((await svc.list()).length).toBe(0);
  });

  it("delete strips the tag id from every entity that references it", async () => {
    const db = freshDb();
    const svc = new TagsService(db);
    await svc.create({ id: "4k" });
    seedMovie(db, "m1", ["4k", "favorite"]);
    seedSeries(db, "s1", ["4k"]);
    seedIndexer(db, "i1", ["4k"]);
    seedClient(db, "d1", "torrent", 1, ["4k"]);

    await svc.remove("4k");

    // only "4k" is stripped; unrelated tags survive
    expect((db.select().from(schema.movie).where(eq(schema.movie.id, "m1")).all()[0] as any).tags).toEqual(["favorite"]);
    expect((db.select().from(schema.series).where(eq(schema.series.id, "s1")).all()[0] as any).tags).toEqual([]);
    expect((db.select().from(schema.indexer).where(eq(schema.indexer.id, "i1")).all()[0] as any).tags).toEqual([]);
    expect((db.select().from(schema.downloadClient).where(eq(schema.downloadClient.id, "d1")).all()[0] as any).tags).toEqual([]);
  });
});

describe("C6 tagApplies routing rule", () => {
  it("untagged provider serves everything", () => {
    expect(tagApplies([], ["4k"])).toBe(true);
    expect(tagApplies(undefined, [])).toBe(true);
    expect(tagApplies(null, undefined)).toBe(true);
  });
  it("tagged provider only serves media sharing a tag", () => {
    expect(tagApplies(["4k"], ["4k", "favorite"])).toBe(true);
    expect(tagApplies(["4k"], ["hdr"])).toBe(false);
    expect(tagApplies(["4k"], [])).toBe(false); // untagged media not served by tagged provider
  });
});

describe("C6 download-client tag-routing", () => {
  function providers(db: Db): ProvidersService {
    return new ProvidersService(
      db, new ProviderRegistry(), new MemoryIndexerProvider(), new MemoryDownloadClientProvider(),
      new ConfigService(db), new ProviderStatusService(db, new ConfigService(db)),
    );
  }

  it("picks a matching tagged client over an untagged one", async () => {
    const db = freshDb();
    seedClient(db, "untagged", "torrent", 5, []);
    seedClient(db, "tagged4k", "torrent", 1, ["4k"]);
    seedClient(db, "taggedHdr", "torrent", 2, ["hdr"]);
    const svc = providers(db);
    const picked = await svc.pickDownloadClient("torrent", undefined, ["4k"]);
    expect(picked.row?.id).toBe("tagged4k"); // higher priority + intersects the media tag
  });

  it("untagged media only gets an untagged client", async () => {
    const db = freshDb();
    seedClient(db, "untagged", "torrent", 5, []);
    seedClient(db, "tagged4k", "torrent", 1, ["4k"]);
    const svc = providers(db);
    const picked = await svc.pickDownloadClient("torrent", undefined, []);
    expect(picked.row?.id).toBe("untagged");
  });

  it("explicit downloadClientId is honored verbatim regardless of tags", async () => {
    const db = freshDb();
    seedClient(db, "untagged", "torrent", 5, []);
    seedClient(db, "taggedHdr", "torrent", 2, ["hdr"]);
    const svc = providers(db);
    const picked = await svc.pickDownloadClient("torrent", "taggedHdr", ["4k"]);
    expect(picked.row?.id).toBe("taggedHdr"); // manual override, even though it doesn't match the media tag
  });
});
