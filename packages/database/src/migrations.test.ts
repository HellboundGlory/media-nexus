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
 * Builds a scratch migrations folder containing only the migrations strictly BEFORE
 * `beforeTag` (by journal index, not filename string-prefix — a later migration's
 * filename can still sort before `beforeTag` alphabetically once there are 10+, and a
 * naive `startsWith` filter only excludes the exact tag, silently leaking every
 * migration that comes after it into what's meant to be an "old-shape" DB. This bit
 * migration 0008's own test suite when it reused the 0007 test's `startsWith` pattern).
 */
function migrationsFolderBefore(beforeTag: string, tmpDir: string): void {
  mkdirSync(join(tmpDir, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf-8")) as {
    entries: { idx: number; tag: string }[];
  };
  const cutoffIdx = journal.entries.find((e) => e.tag === beforeTag)?.idx;
  if (cutoffIdx === undefined) throw new Error(`No journal entry with tag ${beforeTag}`);
  const keep = journal.entries.filter((e) => e.idx < cutoffIdx);
  const keepTags = new Set(keep.map((e) => e.tag));
  for (const f of readdirSync(MIGRATIONS_DIR)) {
    if (f === "meta" || !keepTags.has(f.replace(/\.sql$/, ""))) continue;
    copyFileSync(join(MIGRATIONS_DIR, f), join(tmpDir, f));
  }
  writeFileSync(join(tmpDir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: keep }));
  const keepPrefixes = new Set(keep.map((e) => e.tag.slice(0, 4)));
  for (const f of readdirSync(join(MIGRATIONS_DIR, "meta"))) {
    if (f === "_journal.json" || !keepPrefixes.has(f.slice(0, 4))) continue;
    copyFileSync(join(MIGRATIONS_DIR, "meta", f), join(tmpDir, "meta", f));
  }
}

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
    // Build a migrations folder containing every migration EXCEPT 0007 (and anything
    // after it), so we can land the DB at the old (grid) shape before applying the
    // change under test.
    tmpDir = mkdtempSync(join(tmpdir(), "mn-migration-test-"));
    migrationsFolderBefore("0007_quality_registry", tmpDir);

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

/**
 * Roadmap P0.7 (gap report I9 / J2) acceptance criterion: a database created
 * before this migration migrates cleanly with existing rows preserved, and the
 * newly-declared foreign keys actually enforce cascade/set-null behavior
 * afterward — not just that the migration runs without throwing.
 */
describe("migration 0008 — foreign keys", () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("preserves existing rows and enforces cascade/set-null after migrating", () => {
    // Build a migrations folder containing every migration EXCEPT 0008 (and anything
    // after it), so we can land the DB at the pre-FK shape before applying the change
    // under test.
    tmpDir = mkdtempSync(join(tmpdir(), "mn-migration-0008-test-"));
    migrationsFolderBefore("0008_foreign_keys", tmpDir);

    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: tmpDir });

    const now = new Date().toISOString();

    // Seed a full pre-existing-data scenario: a quality profile, a download client, a
    // series with a season and two episodes, a movie, and a queue entry — everything
    // the six new FKs touch.
    sqlite.prepare(
      "INSERT INTO quality_profile (id,name,items,cutoff_quality_id,upgrade_allowed,language,is_default,created_at,updated_at) VALUES ('qp1','Any','[0]',0,1,'en',1,?,?)",
    ).run(now, now);
    sqlite.prepare(
      "INSERT INTO download_client (id,name,implementation,kind,enabled,priority,settings,tags,created_at,updated_at) VALUES ('dc1','Client','sabnzbd','usenet',1,1,'{}','[]',?,?)",
    ).run(now, now);
    sqlite.prepare(
      "INSERT INTO series (id,tvdb_id,title,monitored,quality_profile_id,added_at,updated_at) VALUES ('sr1',1,'Show',1,'qp1',?,?)",
    ).run(now, now);
    sqlite.prepare(
      "INSERT INTO season (id,series_id,season_number,monitored) VALUES ('se1','sr1',1,1)",
    ).run();
    sqlite.prepare(
      "INSERT INTO episode (id,series_id,season_id,episode_number,monitored,has_file) VALUES ('ep1','sr1','se1',1,1,0),('ep2','sr1','se1',2,1,0)",
    ).run();
    sqlite.prepare(
      "INSERT INTO movie (id,title,monitored,quality_profile_id,added_at,updated_at) VALUES ('mv1','Movie',1,'qp1',?,?)",
    ).run(now, now);
    sqlite.prepare(
      "INSERT INTO download_queue_entry (id,media_type,media_id,download_client_id,title,added_at,updated_at) VALUES ('dq1','movie','mv1','dc1','Movie Release',?,?)",
    ).run(now, now);

    // Now apply the real, full migration chain (including 0008) on top.
    migrate(db, { migrationsFolder: MIGRATIONS_DIR });

    // No rows lost across the rebuild.
    expect(sqlite.prepare("SELECT COUNT(*) c FROM series").get()).toEqual({ c: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) c FROM season").get()).toEqual({ c: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) c FROM episode").get()).toEqual({ c: 2 });
    expect(sqlite.prepare("SELECT COUNT(*) c FROM movie").get()).toEqual({ c: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) c FROM download_queue_entry").get()).toEqual({ c: 1 });
    const series = sqlite.prepare("SELECT quality_profile_id FROM series WHERE id='sr1'").get() as { quality_profile_id: string };
    expect(series.quality_profile_id).toBe("qp1");

    // Cascade: deleting the series deletes its season and episodes.
    sqlite.prepare("DELETE FROM series WHERE id='sr1'").run();
    expect(sqlite.prepare("SELECT COUNT(*) c FROM season").get()).toEqual({ c: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) c FROM episode").get()).toEqual({ c: 0 });

    // Set null: deleting the quality profile nulls out the movie's reference instead
    // of blocking or cascading.
    sqlite.prepare("DELETE FROM quality_profile WHERE id='qp1'").run();
    const movie = sqlite.prepare("SELECT quality_profile_id FROM movie WHERE id='mv1'").get() as { quality_profile_id: string | null };
    expect(movie.quality_profile_id).toBeNull();
    expect(sqlite.prepare("SELECT COUNT(*) c FROM movie").get()).toEqual({ c: 1 }); // movie itself survives

    // Set null: deleting the download client nulls out the queue entry's reference.
    sqlite.prepare("DELETE FROM download_client WHERE id='dc1'").run();
    const queueEntry = sqlite.prepare("SELECT download_client_id FROM download_queue_entry WHERE id='dq1'").get() as { download_client_id: string | null };
    expect(queueEntry.download_client_id).toBeNull();
    expect(sqlite.prepare("SELECT COUNT(*) c FROM download_queue_entry").get()).toEqual({ c: 1 }); // queue entry survives

    sqlite.close();
  });
});

/**
 * Roadmap D2 (real RSS sync) acceptance criterion: a database created before this
 * migration migrates cleanly, and the new seen_release -> indexer FK actually cascades.
 */
describe("migration 0009 — seen_release", () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("adds seen_release with a cascading FK to indexer", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mn-migration-0009-test-"));
    migrationsFolderBefore("0009_seen_release", tmpDir);

    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: tmpDir });

    const now = new Date().toISOString();
    sqlite.prepare(
      "INSERT INTO indexer (id,definition_key,name,protocol,enabled,implementation,settings,priority,status,tags,created_at,updated_at) VALUES ('idx1','newznab','Test','usenet',1,'newznab','{}',25,'ok','[]',?,?)",
    ).run(now, now);

    // Now apply the real, full migration chain (including 0009) on top.
    migrate(db, { migrationsFolder: MIGRATIONS_DIR });

    expect(sqlite.prepare("SELECT COUNT(*) c FROM indexer").get()).toEqual({ c: 1 });

    sqlite.prepare(
      "INSERT INTO seen_release (id,indexer_id,guid,first_seen_at) VALUES ('sr1','idx1','guid-1',?)",
    ).run(now);
    expect(sqlite.prepare("SELECT COUNT(*) c FROM seen_release").get()).toEqual({ c: 1 });

    // Cascade: deleting the indexer deletes its seen_release rows.
    sqlite.prepare("DELETE FROM indexer WHERE id='idx1'").run();
    expect(sqlite.prepare("SELECT COUNT(*) c FROM seen_release").get()).toEqual({ c: 0 });

    sqlite.close();
  });
});
