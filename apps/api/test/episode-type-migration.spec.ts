// SPDX-License-Identifier: MIT
/**
 * EPISODEDETAIL-1 — forward-migration safety for the additive episode_type column (migration 0010).
 *
 * Mirrors import-exclusion.spec.ts's IMPORTEXCLTITLE-1 test: an OLD-shape `episode` table
 * (pre-episode_type) with existing rows must survive applying the real generated 0010 migration
 * — legacy rows get NULL episode_type (no badge, which is the expected pre-refresh behavior).
 * Uses the ACTUAL migration file from disk, not a copy.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@medianexus/database";

const dir = mkdtempSync(join(tmpdir(), "mn-episode-type-mig-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });

describe("episode forward migration (0010, additive episode_type)", () => {
  let migrationSql: string;

  beforeAll(() => {
    const migDir = resolve(__dirname, "../../../packages/database/migrations");
    const files = readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort();
    const additive = files.map((f) => ({ f, s: readFileSync(join(migDir, f), "utf8") }))
      .filter(({ s }) => s.includes("`episode`") && s.includes("`episode_type`")).pop();
    if (!additive) throw new Error("no episode episode_type additive migration found");
    migrationSql = additive.s;
    expect(migrationSql).toMatch(/episode_type/);
  });

  it("applies the additive column to an old-shape episode table without touching existing rows", () => {
    const dbPath = join(dir, "oldshape.db");
    const db = new Database(dbPath);
    // The pre-0010 episode shape (id + the essential columns; a real old DB has the rest, but
    // this slice is all the migration touches).
    db.exec(
      "CREATE TABLE `episode` (`id` text PRIMARY KEY NOT NULL, `series_id` text NOT NULL, `season_id` text NOT NULL, `episode_number` integer NOT NULL, `title` text DEFAULT '' NOT NULL, `air_date_utc` text);",
    );
    db.prepare(
      "INSERT INTO episode (id, series_id, season_id, episode_number, title, air_date_utc) VALUES ('e1','s1','sea1',1,'Pilot','2024-01-01'),('e2','s1','sea1',2,'Episode 2','2024-01-08')",
    ).run();

    for (const stmt of migrationSql.split("--> statement-breakpoint")) {
      const s = stmt.trim();
      if (s) db.exec(s);
    }

    const rows = db.prepare("SELECT id, episode_number, title, episode_type FROM episode ORDER BY id").all() as {
      id: string; episode_number: number; title: string; episode_type: string | null;
    }[];
    // Existing rows intact, new column present and NULL (legacy fallback).
    expect(rows).toEqual([
      { id: "e1", episode_number: 1, title: "Pilot", episode_type: null },
      { id: "e2", episode_number: 2, title: "Episode 2", episode_type: null },
    ]);
    db.close();
  });

  it("fresh DBs still migrate to head with the new column", async () => {
    const handle = createDb(join(dir, "fresh.db"));
    handle.runMigrations();
    handles.push(handle);
    // Resolve the schema's own episode table so the query builder types align; the runtime check
    // is that a fresh head-migrated DB exposes the column (a missing column would throw on read).
    const rows = await handle.db.select({ id: schema.episode.id, episodeType: schema.episode.episodeType })
      .from(schema.episode).where(eq(schema.episode.id, "nope"));
    expect(Array.isArray(rows)).toBe(true); // query ran -> column exists
  });
});
