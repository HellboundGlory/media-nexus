// SPDX-License-Identifier: MIT
/**
 * Roadmap P0.3 (gap report B1): before this, nothing evaluated whether a release should
 * be grabbed — grab was unconditional. This covers DecisionService, the API-layer piece
 * that assembles DecisionContext (DB-backed) and calls the pure domain evaluate() from
 * packages/domain/src/decision.ts (whose own unit tests cover the specs in isolation).
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, schema } from "@medianexus/database";
import { qualityId, type Release } from "@medianexus/domain";
import { DecisionService } from "../src/decision/decision.service";
import { MediaRepository } from "../src/media/media.repository";
import { BlocklistService } from "../src/blocklist/blocklist.service";
import { ConfigService } from "../src/system/config.service";
import { RootFoldersService } from "../src/root-folders/root-folders.service";
import { IndexersService } from "../src/indexers/indexers.service";
import { EventsService } from "../src/events/events.service";
import { EventBus } from "@medianexus/events";
import type { ProvidersService } from "../src/providers/demo.providers";
import { ProviderStatusService } from "../src/providers/provider-status.service";

const dir = mkdtempSync(join(tmpdir(), "mn-decision-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });

let counter = 0;
async function freshDb() {
  const handle = createDb(join(dir, `dec-${counter++}.db`));
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

async function seedMovie(db: Awaited<ReturnType<typeof freshDb>>, over: Partial<typeof schema.movie.$inferInsert> = {}) {
  const now = new Date().toISOString();
  await db.insert(schema.movie).values({
    id: "m1", tmdbId: 1, title: "Some Movie", overview: "", status: "released", releaseDate: "2020-01-01",
    monitored: true, qualityProfileId: null, rootFolderPath: "", minimumAvailability: "announced",
    genres: [], images: [], tags: [], hasFile: false, addedAt: now, updatedAt: now,
    ...over,
  });
}

async function seedProfile(db: Awaited<ReturnType<typeof freshDb>>, items: number[], cutoffQualityId: number) {
  const now = new Date().toISOString();
  await db.insert(schema.qualityProfile).values({
    id: "qp1", name: "Test", items, cutoffQualityId, upgradeAllowed: true, language: "en",
    isDefault: true, createdAt: now, updatedAt: now,
  });
}

function decisionService(db: Awaited<ReturnType<typeof freshDb>>) {
  return new DecisionService(db, new MediaRepository(db), new BlocklistService(db), new ConfigService(db), new RootFoldersService(db));
}

describe("DecisionService — unresolved target", () => {
  it("rejects when the media doesn't exist", async () => {
    const db = await freshDb();
    const decisions = decisionService(db);
    const d = await decisions.evaluate("movie", "missing", release());
    expect(d.approved).toBe(false);
    expect(d.rejections.map((r) => r.reason)).toEqual(["unresolved_target"]);
  });
});

describe("DecisionService — profile-allowed, from a real quality_profile row", () => {
  it("rejects a quality outside the assigned profile's items", async () => {
    const db = await freshDb();
    await seedProfile(db, [qualityId({ source: "web", resolution: "1080p", edition: "" } as never)], qualityId({ source: "web", resolution: "1080p", edition: "" } as never));
    await seedMovie(db, { qualityProfileId: "qp1" });
    const decisions = decisionService(db);

    const d = await decisions.evaluate("movie", "m1", release({ quality: { source: "sd", resolution: "480p", edition: "" } }));
    expect(d.approved).toBe(false);
    expect(d.rejections.map((r) => r.reason)).toContain("not_allowed_by_profile");
  });

  it("approves a quality the profile allows", async () => {
    const db = await freshDb();
    await seedProfile(db, [qualityId({ source: "web", resolution: "1080p", edition: "" } as never)], qualityId({ source: "web", resolution: "1080p", edition: "" } as never));
    await seedMovie(db, { qualityProfileId: "qp1" });
    const decisions = decisionService(db);

    const d = await decisions.evaluate("movie", "m1", release({ quality: { source: "web", resolution: "1080p", edition: "" } }));
    expect(d.approved).toBe(true);
  });
});

describe("DecisionService — upgrade/cutoff, from a real media_file row", () => {
  it("rejects once the existing file already meets the profile's cutoff", async () => {
    const db = await freshDb();
    const cutoff = qualityId({ source: "web", resolution: "1080p", edition: "" } as never);
    await seedProfile(db, [qualityId({ source: "hdtv", resolution: "720p", edition: "" } as never), cutoff, qualityId({ source: "bluray", resolution: "1080p", edition: "" } as never)], cutoff);
    await seedMovie(db, { qualityProfileId: "qp1" });
    await db.insert(schema.mediaFile).values({
      id: "mf1", mediaType: "movie", mediaId: "m1", episodeIds: [], relativePath: "x.mkv", size: 1000,
      quality: { source: "web", resolution: "1080p", edition: "" }, dateAdded: new Date().toISOString(),
    });
    const decisions = decisionService(db);

    const d = await decisions.evaluate("movie", "m1", release({ quality: { source: "bluray", resolution: "1080p", edition: "" } }));
    expect(d.approved).toBe(false);
    expect(d.rejections.map((r) => r.reason)).toContain("cutoff_already_met");
  });
});

describe("DecisionService — queue conflict, from a real download_queue_entry row", () => {
  it("rejects a release while another download is already active for this media", async () => {
    const db = await freshDb();
    await seedMovie(db);
    const now = new Date().toISOString();
    await db.insert(schema.downloadQueueEntry).values({
      id: "q1", mediaType: "movie", mediaId: "m1", downloadClientId: null, downloadId: "d1",
      title: "Already.Downloading", status: "downloading", progress: 50, size: 1000,
      remainingTime: null, errorMessage: null, data: {}, addedAt: now, updatedAt: now,
    });
    const decisions = decisionService(db);

    const d = await decisions.evaluate("movie", "m1", release());
    expect(d.approved).toBe(false);
    expect(d.rejections.map((r) => r.reason)).toEqual(["queue_conflict"]);
  });
});

describe("DecisionService — protocol preference, from real settings", () => {
  it("rejects a torrent when usenet is the configured preference", async () => {
    const db = await freshDb();
    await seedMovie(db);
    const config = new ConfigService(db);
    await config.upsert({ "media.preferredProtocol": "usenet" });
    const decisions = new DecisionService(db, new MediaRepository(db), new BlocklistService(db), config, new RootFoldersService(db));

    const d = await decisions.evaluate("movie", "m1", release({ protocol: "torrent" }));
    expect(d.approved).toBe(false);
    expect(d.rejections.map((r) => r.reason)).toEqual(["wrong_protocol"]);
  });
});

describe("IndexersService.search() attaches a decision to every result (gap report C3)", () => {
  it("interactive search results carry approval/rejection info", async () => {
    const db = await freshDb();
    await seedProfile(db, [qualityId({ source: "web", resolution: "1080p", edition: "" } as never)], qualityId({ source: "web", resolution: "1080p", edition: "" } as never));
    await seedMovie(db, { qualityProfileId: "qp1" });
    const events = new EventsService(new EventBus());
    const config = new ConfigService(db);
    const decisions = decisionService(db);
    const providers = {
      configuredIndexers: async () => [{
        row: { id: "idx1", name: "Demo" },
        provider: {
          search: async () => [
            release({ id: "allowed", quality: { source: "web", resolution: "1080p", edition: "" } }),
            release({ id: "disallowed", quality: { source: "sd", resolution: "480p", edition: "" } }),
          ],
        },
      }],
    } as unknown as ProvidersService;
    const svc = new IndexersService(db, providers, events, config, decisions, new ProviderStatusService(db, config));

    const res = await svc.search({ mediaType: "movie", mediaId: "m1" });

    expect(res.releases).toHaveLength(2);
    const byId = Object.fromEntries(res.releases.map((r) => [r.id, r]));
    expect(byId.allowed.decision.approved).toBe(true);
    expect(byId.disallowed.decision.approved).toBe(false);
    expect(byId.disallowed.decision.rejections.map((r) => r.reason)).toContain("not_allowed_by_profile");
  });
});
