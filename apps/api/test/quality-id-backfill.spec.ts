// SPDX-License-Identifier: MIT
/**
 * SON-025/RAD-010 — migration round-trip test for the quality-id remap. Builds a database
 * in the OLD (pre-RAD-010) 2D-registry id space, runs `runQualityIdBackfill`, and asserts
 * every persisted id lands on the exact same semantic (source, resolution, modifier=none)
 * meaning under the NEW 3D registry — a silent off-by-one here would scramble a real
 * profile's ranking rather than fail loudly.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "@medianexus/database";
import { qualityId } from "@medianexus/domain";
import { runQualityIdBackfill } from "../src/quality-profiles/quality-id-backfill";

// The OLD registry exactly as it was pre-RAD-010 (id = resIdx * 6 + srcIdx).
const OLD_RES = ["unknown", "480p", "576p", "720p", "1080p", "2160p"];
const OLD_SRC = ["unknown", "sd", "dvd", "hdtv", "web", "bluray"];
const OLD_SRC_COUNT = OLD_SRC.length;
const oldId = (source: string, resolution: string) =>
  OLD_RES.indexOf(resolution) * OLD_SRC_COUNT + OLD_SRC.indexOf(source);

// The same semantic pair under the new registry (modifier defaults to none).
const newId = (source: string, resolution: string) =>
  qualityId({ source: source as never, resolution: resolution as never, edition: "", modifier: "none" });

const dir = mkdtempSync(join(tmpdir(), "mn-qid-"));
const handles: DbHandle[] = [];
afterAll(() => { for (const h of handles) h.close(); });

async function freshDb(): Promise<DbHandle> {
  const handle = createDb(join(dir, `qid-${handles.length}.db`));
  await handle.runMigrations();
  handles.push(handle);
  return handle;
}

describe("runQualityIdBackfill", () => {
  it("remaps quality_profile items/cutoff and quality_definition ids to the same semantics", async () => {
    const handle = await freshDb();
    const db = handle.db;

    // Profile in the OLD id space.
    const items = [oldId("web", "720p"), oldId("hdtv", "720p"), oldId("bluray", "1080p"), oldId("web", "2160p")];
    const cutoff = oldId("web", "1080p");
    const now = new Date().toISOString();
    await db.insert(schema.qualityProfile).values({
      id: "qp_test", name: "Old", items, cutoffQualityId: cutoff,
      upgradeAllowed: true, isDefault: false, language: "en", createdAt: now, updatedAt: now,
    } as never);

    // A quality_definition row at the old (web, 1080p) id (id = 1*6 + 4 = 10).
    const defOldId = oldId("web", "1080p");
    await db.insert(schema.qualityDefinition).values({
      id: defOldId, title: "Web 1080p", minSize: 8, maxSize: 320, preferredSize: 110, updatedAt: now,
    } as never);

    const result = await runQualityIdBackfill(db);
    expect(result.skipped).toBe(false);
    expect(result.profilesUpdated).toBe(1);
    expect(result.definitionsMoved).toBe(1);

    // items/cutoff now use the NEW ids for the same semantics.
    const p = (await db.select().from(schema.qualityProfile).where(eq(schema.qualityProfile.id, "qp_test")))[0];
    expect(p.items).toEqual([
      newId("web", "720p"), newId("hdtv", "720p"), newId("bluray", "1080p"), newId("web", "2160p"),
    ]);
    expect(p.cutoffQualityId).toBe(newId("web", "1080p"));

    // The definition moved to the new id, keeping its size data.
    const defRows = await db.select().from(schema.qualityDefinition);
    expect(defRows.some((d) => d.id === newId("web", "1080p"))).toBe(true);
    const moved = defRows.find((d) => d.id === newId("web", "1080p"));
    expect(moved?.preferredSize).toBe(110);
    expect(defRows.some((d) => d.id === defOldId)).toBe(false);
  });

  it("is idempotent (second run skips via the sentinel)", async () => {
    const handle = await freshDb();
    const db = handle.db;
    const now = new Date().toISOString();
    await db.insert(schema.qualityProfile).values({
      id: "qp_a", name: "A", items: [oldId("web", "720p")], cutoffQualityId: oldId("web", "720p"),
      upgradeAllowed: true, isDefault: false, language: "en", createdAt: now, updatedAt: now,
    } as never);

    const first = await runQualityIdBackfill(db);
    const second = await runQualityIdBackfill(db);
    expect(first.skipped).toBe(false);
    expect(second.skipped).toBe(true);
    // The sentinel row exists.
    const sentinel = await db.select().from(schema.setting).where(eq(schema.setting.key, "meta.qualityId3dRemap"));
    expect(sentinel.length).toBe(1);
  });

  it("leaves already-new ids untouched", async () => {
    const handle = await freshDb();
    const db = handle.db;
    const now = new Date().toISOString();
    const target = newId("bluray", "1080p");
    await db.insert(schema.qualityProfile).values({
      id: "qp_b", name: "B", items: [target], cutoffQualityId: target,
      upgradeAllowed: true, isDefault: false, language: "en", createdAt: now, updatedAt: now,
    } as never);
    await runQualityIdBackfill(db);
    const p = (await db.select().from(schema.qualityProfile).where(eq(schema.qualityProfile.id, "qp_b")))[0];
    expect(p.items).toEqual([target]);
  });
});
