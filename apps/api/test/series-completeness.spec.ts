// SPDX-License-Identifier: MIT
/**
 * SERIESSTATUS-1 — per-series completeness (complete / missing / upcoming / null) attached to
 * GET /series (list) and GET /series/:id by the backend aggregate. Aired = monitored episode with
 * an air date in the past; missing = aired but without a file. complete → everything aired is
 * downloaded, missing → some aired lacks a file, upcoming → nothing has aired yet, unmonitored →
 * null (no bar/badge, per the shared design).
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "@medianexus/events";
import { createDb, schema } from "@medianexus/database";
import { SeriesService } from "../src/series/series.service";
import { AutoTagsService } from "../src/auto-tags/auto-tags.service";
import { EventsService } from "../src/events/events.service";

const dir = mkdtempSync(join(tmpdir(), "mn-series-completeness-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });

let counter = 0;
let tvCounter = 0;
async function freshDb() {
  const handle = createDb(join(dir, `sc-${counter++}.db`));
  handle.runMigrations();
  handles.push(handle);
  return handle.db;
}

async function svc(db: Awaited<ReturnType<typeof freshDb>>) {
  return new SeriesService(db, new EventsService(new EventBus()), new AutoTagsService(db));
}

interface EpSpec { id: string; airDateUtc?: string | null; hasFile?: boolean; monitored?: boolean }

async function seedSeries(db: Awaited<ReturnType<typeof freshDb>>, seriesId: string, monitored: boolean, eps: EpSpec[]) {
  await db.insert(schema.series).values({
    id: seriesId, tvdbId: ++tvCounter, tmdbId: null, imdbId: null, title: `Show ${seriesId}`, overview: "", status: "unknown",
    seriesType: "standard", network: null, firstAirYear: 2020, monitored, qualityProfileId: null,
    rootFolderPath: "", folderName: null, genres: [], images: [], tags: [],
    addedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } as never);
  await db.insert(schema.season).values({ id: `${seriesId}_sea`, seriesId, seasonNumber: 1, monitored: true } as never);
  let n = 1;
  for (const e of eps) {
    await db.insert(schema.episode).values({
      id: e.id, seriesId, seasonId: `${seriesId}_sea`, episodeNumber: n++, title: e.id,
      overview: "", airDateUtc: e.airDateUtc ?? "2020-01-01", monitored: e.monitored ?? true, hasFile: e.hasFile ?? false,
    } as never);
  }
}

describe("SeriesService series completeness (SERIESSTATUS-1)", () => {
  it("returns missing (+count) when an aired monitored episode lacks a file", async () => {
    const db = await freshDb();
    await seedSeries(db, "s_missing", true, [
      { id: "s_missing_e1", airDateUtc: "2020-01-01", hasFile: true },
      { id: "s_missing_e2", airDateUtc: "2021-01-01", hasFile: false },
      { id: "s_missing_e3", airDateUtc: "2100-01-01", hasFile: false }, // future — not counted missing
    ]);
    const s = await svc(db);
    const row = await s.get("s_missing");
    expect(row.completeness).toBe("missing");
    expect(row.missingEpisodeCount).toBe(1);
  });

  it("returns complete when everything aired so far is downloaded", async () => {
    const db = await freshDb();
    await seedSeries(db, "s_complete", true, [
      { id: "s_complete_e1", airDateUtc: "2020-01-01", hasFile: true },
      { id: "s_complete_e2", airDateUtc: "2020-02-01", hasFile: true },
    ]);
    const row = await (await svc(db)).get("s_complete");
    expect(row.completeness).toBe("complete");
    expect(row.missingEpisodeCount).toBe(0);
  });

  it("returns upcoming when nothing has aired yet", async () => {
    const db = await freshDb();
    await seedSeries(db, "s_upcoming", true, [
      { id: "s_upcoming_e1", airDateUtc: "2100-01-01" },
      { id: "s_upcoming_e2", airDateUtc: "2100-02-01" },
    ]);
    const row = await (await svc(db)).get("s_upcoming");
    expect(row.completeness).toBe("upcoming");
    expect(row.missingEpisodeCount).toBe(0);
  });

  it("returns null completeness for an unmonitored series", async () => {
    const db = await freshDb();
    // Unmonitored series with aired-but-missing episodes must still show no badge.
    await seedSeries(db, "s_unmon", false, [
      { id: "s_unmon_e1", airDateUtc: "2020-01-01", hasFile: false },
    ]);
    const row = await (await svc(db)).get("s_unmon");
    expect(row.completeness).toBeNull();
    expect(row.missingEpisodeCount).toBe(0);
  });

  it("attaches completeness to every item in the paged list response", async () => {
    const db = await freshDb();
    await seedSeries(db, "s_li_missing", true, [{ id: "s_li_missing_e1", airDateUtc: "2020-01-01", hasFile: false }]);
    await seedSeries(db, "s_li_complete", true, [{ id: "s_li_complete_e1", airDateUtc: "2020-01-01", hasFile: true }]);
    const s = await svc(db);
    const page = await s.list({});
    const byId = new Map(page.items.map((r) => [r.id, r]));
    expect(byId.get("s_li_missing")?.completeness).toBe("missing");
    expect(byId.get("s_li_complete")?.completeness).toBe("complete");
  });
});
