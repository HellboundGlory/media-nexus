// SPDX-License-Identifier: MIT
/**
 * EPISODEDETAIL-1 — regression test for the /history endpoint's optional episodeId filter.
 *
 * The series' history rows are keyed by seriesId (mediaId), so narrowing to ONE episode needs a
 * server-side member-check of each row's `data` against the resolved episode's
 * series/season/episode numbers:
 *   - import_completed -> exact: data.season equals the season AND one imported entry's `episodes`
 *     array includes the episode number.
 *   - grabbed / download_failed / removed -> best-effort via parseEpisodeRelease applied to the
 *     release title (season matches AND episodes include the number OR it's a season pack).
 *   - any other action -> excluded when episodeId filtering is active.
 * Plus the REVIEW fix: once an episode is resolved, the query is additionally scoped to that
 * episode's seriesId, so a coincidentally same season/episode-numbered row from a DIFFERENT
 * series can never leak into the result.
 * Tested at the full controller level against a real seeded SQLite DB with the acquisition
 * importer's real history data shapes.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, schema } from "@medianexus/database";
import { newEntityId } from "@medianexus/shared";
import { ActivityController } from "../src/activity/activity.controller";

const dir = mkdtempSync(join(tmpdir(), "mn-episode-history-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });

let counter = 0;
async function freshDb() {
  const handle = createDb(join(dir, `eh-${counter++}.db`));
  handle.runMigrations();
  handles.push(handle);
  return handle.db;
}

// The controller's history handler only uses this.db (episode resolution) + the stubbed
// services for the other routes, which we never call — empty stubs are fine.
function harness(db: Awaited<ReturnType<typeof freshDb>>) {
  const controller = new ActivityController(db, {} as never, {} as never);
  return { controller };
}

let seedCounter = 1000;
async function seedSeriesWithEpisodes(db: Awaited<ReturnType<typeof freshDb>>, seriesId = "s_epd") {
  seedCounter++;
  await db.insert(schema.series).values({
    id: seriesId, tvdbId: seedCounter, tmdbId: null, imdbId: null, title: "Show " + seriesId, overview: "", status: "unknown",
    seriesType: "standard", network: null, firstAirYear: 2020, monitored: true, qualityProfileId: null,
    rootFolderPath: "", folderName: null, genres: [], images: [], tags: [],
    addedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } as never);
  for (let s = 1; s <= 2; s++) {
    await db.insert(schema.season).values({ id: `${seriesId}_s${s}`, seriesId, seasonNumber: s, monitored: true } as never);
    for (let e = 1; e <= 3; e++) {
      await db.insert(schema.episode).values({
        id: `ep_${seriesId}_${s}_${e}`, seriesId, seasonId: `${seriesId}_s${s}`, episodeNumber: e,
        title: `E${e}`, overview: "", airDateUtc: "2020-01-01", monitored: true, hasFile: false,
      } as never);
    }
  }
  return seriesId;
}

describe("GET /history?episodeId= (EPISODEDETAIL-1)", () => {
  it("import_completed rows match exactly by season + episode number", async () => {
    const db = await freshDb();
    const seriesId = await seedSeriesWithEpisodes(db);
    const { controller } = harness(db);
    const now = new Date().toISOString();
    await db.insert(schema.historyEntry).values({ id: newEntityId("hist"), mediaType: "series", mediaId: seriesId, action: "import_completed", data: {
      title: "S01E01", season: 1, imported: [{ mediaFileId: "mf1", path: "x.mkv", episodes: [1, 2] }],
    }, createdAt: now } as never);
    // A second episode's import row (S01E02) that must NOT leak into the S01E01 filter.
    await db.insert(schema.historyEntry).values({ id: newEntityId("hist"), mediaType: "series", mediaId: seriesId, action: "import_completed", data: {
      title: "S01E03", season: 1, imported: [{ mediaFileId: "mf2", path: "y.mkv", episodes: [3] }],
    }, createdAt: now } as never);

    const res = await controller.history({ episodeId: "ep_s_epd_1_1", mediaType: "series", mediaId: seriesId, limit: 50 });
    expect(res.items).toHaveLength(1);
    expect((res.items[0].data as { imported?: { mediaFileId?: string }[] }).imported?.[0]?.mediaFileId).toBe("mf1");
  });

  it("excludes import_completed rows for a different season", async () => {
    const db = await freshDb();
    const seriesId = await seedSeriesWithEpisodes(db);
    const { controller } = harness(db);
    await db.insert(schema.historyEntry).values({ id: newEntityId("hist"), mediaType: "series", mediaId: seriesId, action: "import_completed", data: {
      title: "S02E01", season: 2, imported: [{ mediaFileId: "mf1", path: "x.mkv", episodes: [1] }],
    }, createdAt: new Date().toISOString() } as never);

    const res = await controller.history({ episodeId: "ep_s_epd_1_1", mediaType: "series", mediaId: seriesId, limit: 50 });
    expect(res.items).toHaveLength(0);
  });

  it("grabbed rows match by parsing the release title", async () => {
    const db = await freshDb();
    const seriesId = await seedSeriesWithEpisodes(db);
    const { controller } = harness(db);
    await db.insert(schema.historyEntry).values({ id: newEntityId("hist"), mediaType: "series", mediaId: seriesId, action: "grabbed", data: {
      releaseTitle: "Show.S01E02.1080p.WEB", downloadId: "d1",
    }, createdAt: new Date().toISOString() } as never);

    // ep 1 -> no match; ep 2 -> match
    const res1 = await controller.history({ episodeId: "ep_s_epd_1_1", mediaType: "series", mediaId: seriesId, limit: 50 });
    expect(res1.items).toHaveLength(0);
    const res2 = await controller.history({ episodeId: "ep_s_epd_1_2", mediaType: "series", mediaId: seriesId, limit: 50 });
    expect(res2.items).toHaveLength(1);
  });

  it("matches a season pack and a removed row's title", async () => {
    const db = await freshDb();
    const seriesId = await seedSeriesWithEpisodes(db);
    const { controller } = harness(db);
    // Season pack grabbed: covers every episode of season 1 -> matches any season-1 episode.
    await db.insert(schema.historyEntry).values({ id: newEntityId("hist"), mediaType: "series", mediaId: seriesId, action: "grabbed", data: {
      releaseTitle: "Show.S01.WEB", downloadId: "d1",
    }, createdAt: new Date().toISOString() } as never);
    // A removed row keyed by data.title.
    await db.insert(schema.historyEntry).values({ id: newEntityId("hist"), mediaType: "series", mediaId: seriesId, action: "removed", data: {
      title: "Show.S01E03.720p", downloadId: "d2",
    }, createdAt: new Date().toISOString() } as never);

    const s1e1 = await controller.history({ episodeId: "ep_s_epd_1_1", mediaType: "series", mediaId: seriesId, limit: 50 });
    expect(s1e1.items).toHaveLength(1); // the season pack
    const s1e3 = await controller.history({ episodeId: "ep_s_epd_1_3", mediaType: "series", mediaId: seriesId, limit: 50 });
    expect(s1e3.items).toHaveLength(2); // season pack + removed row
  });

  it("excludes action types whose episode membership can't be confirmed", async () => {
    const db = await freshDb();
    const seriesId = await seedSeriesWithEpisodes(db);
    const { controller } = harness(db);
    await db.insert(schema.historyEntry).values({ id: newEntityId("hist"), mediaType: "series", mediaId: seriesId, action: "some_other_action", data: {
      title: "Show.S01E01", downloadId: "d1",
    }, createdAt: new Date().toISOString() } as never);

    const res = await controller.history({ episodeId: "ep_s_epd_1_1", mediaType: "series", mediaId: seriesId, limit: 50 });
    expect(res.items).toHaveLength(0);
  });

  it("returns empty when the episode id doesn't exist", async () => {
    const db = await freshDb();
    await seedSeriesWithEpisodes(db);
    const { controller } = harness(db);
    const res = await controller.history({ episodeId: "ep_missing", limit: 50 });
    expect(res.items).toHaveLength(0);
  });

  it("does not leak a same-numbered row from a DIFFERENT series (REVIEW fix: scopes to episode's seriesId)", async () => {
    const db = await freshDb();
    const { controller } = harness(db);
    // Two series each with an S01E01 (coincidentally overlapping season/episode numbers).
    await seedSeriesWithEpisodes(db, "s_alpha");
    await seedSeriesWithEpisodes(db, "s_beta");
    // A grabbed row for series B's S01E01 whose release title also parses as S01E01 — under the
    // old unscooped logic it would match series A's S01E01 purely by number.
    await db.insert(schema.historyEntry).values({ id: newEntityId("hist"), mediaType: "series", mediaId: "s_beta", action: "grabbed", data: {
      releaseTitle: "Beta.S01E01.1080p.WEB", downloadId: "d1",
    }, createdAt: new Date().toISOString() } as never);

    // Query series A's S01E01 WITHOUT passing mediaId — the fix must clamp to A via the
    // episode's own seriesId, so B's row must not appear.
    const res = await controller.history({ episodeId: "ep_s_alpha_1_1", limit: 50 });
    expect(res.items).toHaveLength(0);
  });
});
