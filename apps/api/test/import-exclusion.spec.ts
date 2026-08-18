// SPDX-License-Identifier: MIT
/**
 * IMPORTEXCLTITLE-1 — import_exclusion now stores a resolved title/year so the Settings >
 * Import Lists > Exclusions table shows a real title instead of a raw numeric id.
 *
 * Covers:
 *  1. Forward-migration safety: an OLD-shape import_exclusion (pre-title/year) with existing
 *     rows survives applying the new additive migration — legacy rows get NULL title/year
 *     (the UI falls back to the raw id, exactly today's behavior). Built the old-shape DB by
 *     hand (matching this repo's upstream-import.spec.ts raw-SQL pattern) and applies the
 *     ACTUAL generated 0008 migration file from disk, not a copy.
 *  2. addExclusion resolves + stores the title/year from TMDB on the manual-add path.
 *  3. addExclusion still creates the row (title NULL) when the lookup fails — best-effort.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@medianexus/database";
import { ImportListsService } from "../src/import-lists/import-lists.service";

const dir = mkdtempSync(join(tmpdir(), "mn-import-excl-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });

let counter = 0;
async function freshDb() {
  const handle = createDb(join(dir, `ex-${counter++}.db`));
  handle.runMigrations();
  handles.push(handle);
  return handle;
}

/** Fake metadata service — providers only the exposed surface addExclusion needs, so tests don't
 *  hit a real TMDB API. */
function stubMetadata(getDetails: (mediaType: "movie" | "series", externalId: string) => Promise<{ title: string; year?: number }>) {
  return {
    provider: async () => ({ getDetails }),
  } as never;
}

describe("import_exclusion forward migration (0008, additive title/year)", () => {
  let migrationSql: string;
  let dbPath: string;
  let db: Database.Database;

  beforeAll(() => {
    // Locate the newest generated SQLite migration file (this change produced 0008_*).
    const migDir = resolve(__dirname, "../../../packages/database/migrations");
    const files = readdirSync(migDir).filter((f) => f.endsWith(".sql"));
    files.sort();
    const newest = files[files.length - 1];
    if (!newest) throw new Error("no migration files found");
    migrationSql = readFileSync(join(migDir, newest), "utf8");
    expect(migrationSql).toMatch(/import_exclusion/);
  });

  it("applies the additive columns to an old-shape table without touching existing rows", () => {
    dbPath = join(dir, "oldshape.db");
    db = new Database(dbPath);
    // The pre-0008 import_exclusion shape (id/media_type/external_id/reason/created_at + unique idx).
    db.exec(
      "CREATE TABLE `import_exclusion` (id text PRIMARY KEY NOT NULL, media_type text NOT NULL, external_id text NOT NULL, reason text, created_at text);" +
      "CREATE UNIQUE INDEX `import_exclusion_media_ext_idx` ON `import_exclusion` (media_type, external_id);",
    );
    db.prepare(
      "INSERT INTO import_exclusion (id, media_type, external_id, reason, created_at) VALUES ('excl1','movie','1','removed from library','2024-01-01T00:00:00.000Z'),('excl2','series','2','manual','2024-01-02T00:00:00.000Z')",
    ).run();

    // Run the real migration SQL (split on drizzle's statement-breakpoint separator).
    for (const stmt of migrationSql.split("--> statement-breakpoint")) {
      const s = stmt.trim();
      if (s) db.exec(s);
    }

    const rows = db.prepare("SELECT id, media_type, external_id, reason, title, year FROM import_exclusion ORDER BY id").all() as {
      id: string; media_type: string; external_id: string; reason: string; title: string | null; year: number | null;
    }[];
    // Existing rows are intact, with the new columns present and NULL (legacy fallback).
    expect(rows).toEqual([
      { id: "excl1", media_type: "movie", external_id: "1", reason: "removed from library", title: null, year: null },
      { id: "excl2", media_type: "series", external_id: "2", reason: "manual", title: null, year: null },
    ]);
    db.close();
  });
});

describe("ImportListsService.addExclusion title resolution", () => {
  it("stores the resolved title/year from TMDB on a manual add", async () => {
    const handle = await freshDb();
    const svc = new ImportListsService(handle.db, stubMetadata(async () => ({ title: "Dune", year: 2021 })));
    await svc.addExclusion({ mediaType: "movie", externalId: "438631", reason: "manual" });
    const row = await handle.db.select().from(schema.importExclusion).where(eq(schema.importExclusion.mediaType, "movie")).limit(1);
    expect(row[0].title).toBe("Dune");
    expect(row[0].year).toBe(2021);
  });

  it("still creates the exclusion with NULL title when the lookup fails", async () => {
    const handle = await freshDb();
    const svc = new ImportListsService(handle.db, stubMetadata(async () => {
      throw new Error("provider unreachable");
    }));
    await svc.addExclusion({ mediaType: "series", externalId: "99999" });
    const row = await handle.db.select().from(schema.importExclusion).where(eq(schema.importExclusion.mediaType, "series")).limit(1);
    expect(row[0].externalId).toBe("99999");
    expect(row[0].title).toBeNull();
  });
});
