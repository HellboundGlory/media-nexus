// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, copyFileSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { qualityId } from "@medianexus/domain";
import { MIGRATIONS_DIR } from "./connection";

/**
 * Roadmap P0.2 acceptance criterion: "a database created before this change
 * migrates cleanly, with its profiles preserved and mapped to the new
 * representation". Builds a DB at the pre-0007 (grid) shape, seeds it exactly
 * as the old `seedStatic` did, then runs migration 0007 and asserts the
 * conversion. Mirrors the "build a source DB and migrate it" pattern used in
 * apps/api/test/import.spec.ts.
 */
describe("migration 0007 — quality registry", () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("converts grid profiles to ordered items + cutoffQualityId, preserving all rows", () => {
    // Build a migrations folder containing every migration EXCEPT 0007, so we can
    // land the DB at the old (grid) shape before applying the change under test.
    tmpDir = mkdtempSync(join(tmpdir(), "mn-migration-test-"));
    mkdirSync(join(tmpDir, "meta"), { recursive: true });
    for (const f of readdirSync(MIGRATIONS_DIR)) {
      if (f === "meta" || f.startsWith("0007")) continue;
      copyFileSync(join(MIGRATIONS_DIR, f), join(tmpDir, f));
    }
    const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf-8"));
    journal.entries = journal.entries.filter((e: { tag: string }) => !e.tag.startsWith("0007"));
    writeFileSync(join(tmpDir, "meta", "_journal.json"), JSON.stringify(journal));
    for (const f of readdirSync(join(MIGRATIONS_DIR, "meta"))) {
      if (f === "_journal.json" || f === "0007_snapshot.json") continue;
      copyFileSync(join(MIGRATIONS_DIR, "meta", f), join(tmpDir, "meta", f));
    }

    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: tmpDir });

    // Seed old-shape rows exactly as pre-P0.2 seedStatic did.
    const now = new Date().toISOString();
    const oldProfiles = [
      { id: "qp_any", name: "Any", allowed: [{ source: "sd", resolution: "480p" }, { source: "web", resolution: "1080p" }, { source: "bluray", resolution: "2160p" }], cutoff: { source: "web", resolution: "1080p" } },
      { id: "qp_hd1080p", name: "HD-1080p", allowed: [{ source: "hdtv", resolution: "720p" }, { source: "web", resolution: "1080p" }, { source: "bluray", resolution: "1080p" }], cutoff: { source: "web", resolution: "1080p" } },
      { id: "imp_q1", name: "Migrated from Radarr", allowed: [{ source: "web", resolution: "1080p" }], cutoff: { source: "web", resolution: "1080p" } },
    ];
    const insert = sqlite.prepare(
      "INSERT INTO quality_profile (id,name,allowed,cutoff,upgrade_allowed,language,is_default,created_at,updated_at) VALUES (?,?,?,?,1,'en',0,?,?)",
    );
    for (const p of oldProfiles) insert.run(p.id, p.name, JSON.stringify(p.allowed), JSON.stringify(p.cutoff), now, now);

    // Now apply the real, full migration chain (including 0007) on top.
    migrate(db, { migrationsFolder: MIGRATIONS_DIR });

    const rows = sqlite.prepare("SELECT id, name, items, cutoff_quality_id FROM quality_profile ORDER BY id").all() as
      { id: string; name: string; items: string; cutoff_quality_id: number }[];

    expect(rows.length).toBe(oldProfiles.length); // no rows lost
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

    // "Any": 3 distinct qualities in, 3 ids out, ascending order, cutoff carried through.
    const any = JSON.parse(byId.qp_any.items) as number[];
    expect(any).toHaveLength(3);
    expect(any).toEqual([...any].sort((a, b) => a - b)); // stored worst -> best
    expect(any).toContain(byId.qp_any.cutoff_quality_id);

    // Cross-check against the live registry: web/1080p must be the computed cutoff id.
    expect(byId.qp_any.cutoff_quality_id).toBe(qualityId({ source: "web", resolution: "1080p", edition: "" } as never));
    expect(byId.qp_hd1080p.cutoff_quality_id).toBe(qualityId({ source: "web", resolution: "1080p", edition: "" } as never));

    // Single-quality profile (the upstream-importer shape) round-trips to one item.
    const imported = JSON.parse(byId.imp_q1.items) as number[];
    expect(imported).toEqual([qualityId({ source: "web", resolution: "1080p", edition: "" } as never)]);

    sqlite.close();
  });
});
