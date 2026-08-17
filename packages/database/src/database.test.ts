// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { createDb } from "./connection";
import { schema as sqliteSchema } from "./schema";
import { schema as pgSchema } from "./schema.pg";
import { seedStatic } from "./seed";

describe("database", () => {
  it("opens an in-memory DB, applies migrations and seeds static data", async () => {
    const handle = createDb(":memory:");
    handle.runMigrations();
    // schema introspection via drizzle (count tables in sqlite_master)
    const tables = handle.db.all(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const names = tables.map((t: { name: string }) => t.name as string);
    for (const t of ["api_key", "movie", "series", "job_run", "indexer", "audit_log"]) {
      expect(names).toContain(t);
    }

    await seedStatic(handle.db);
    const profiles = handle.db.select().from(sqliteSchema.qualityProfile).all();
    expect(profiles.length).toBeGreaterThanOrEqual(3);
    for (const p of profiles) {
      expect(p.items.length).toBeGreaterThan(0);
      expect(p.items).toContain(p.cutoffQualityId);
    }
    const qualityDefs = handle.db.select().from(sqliteSchema.qualityDefinition).all();
    expect(qualityDefs.length).toBe(144); // 8 sources x 6 resolutions x 3 modifiers (RAD-010)
    const defs = handle.db.select().from(sqliteSchema.indexerDefinition).all();
    expect(defs.some((d) => d.key === "memory")).toBe(true);
    const jobs = handle.db.select().from(sqliteSchema.jobDefinition).all();
    expect(jobs.some((j) => j.key === "system.healthCheck")).toBe(true);
    handle.close();
  });

  it("Postgres schema mirrors SQLite: same tables with the same column names", () => {
    const sqliteTables = Object.keys(sqliteSchema);
    const pgTables = Object.keys(pgSchema);
    expect(pgTables.sort()).toEqual(sqliteTables.sort());

    // Compare column names per table via the drizzle column registry symbol.
    const columnSymbol = Symbol.for("drizzle:Columns");
    for (const name of sqliteTables) {
      const s = sqliteSchema[name as keyof typeof sqliteSchema] as unknown as Record<symbol, object>;
      const p = pgSchema[name as keyof typeof pgSchema] as unknown as Record<symbol, object>;
      const sCols = Object.keys(s[columnSymbol] ?? {});
      const pCols = Object.keys(p[columnSymbol] ?? {});
      expect(pCols.sort(), `table ${name}`).toEqual(sCols.sort());
    }
  });

  it("a Postgres migration set has been generated (migrations-pg folder non-empty)", () => {
    const files = readdirSync("./migrations-pg").filter((f) => f.endsWith(".sql"));
    expect(files.length).toBeGreaterThan(0);
    const sql = readFileSync(`./migrations-pg/${files[0]}`, "utf8");
    // Sanity: the generated pg migration differs from SQLite — native boolean + jsonb
    // (types are unquoted; column identifiers are quoted).
    expect(sql).toMatch(/boolean DEFAULT true/);
    expect(sql).toMatch(/jsonb/);
    // And the ISO timestamps stayed text (documented tradeoff), not native timestamp.
    expect(sql).not.toMatch(/timestamp/);
  });

  it("a Postgres DATABASE_URL routes createDb to a non-SQLite handle whose backup rejects with a pg_dump message", async () => {
    const handle = createDb("postgres://user:pass@127.0.0.1:1/nope");
    await expect(handle.backup("/tmp/x.db")).rejects.toThrow(/pg_dump/);
    await expect(handle.runMigrations()).rejects.toThrow(); // no reachable DB — but must not attempt SQLite backup API
    await handle.close();
  });
});
