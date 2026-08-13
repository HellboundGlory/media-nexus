// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { createDb } from "./connection";
import { schema } from "./schema";
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
    const profiles = handle.db.select().from(schema.qualityProfile).all();
    expect(profiles.length).toBeGreaterThanOrEqual(3);
    for (const p of profiles) {
      expect(p.items.length).toBeGreaterThan(0);
      expect(p.items).toContain(p.cutoffQualityId);
    }
    const qualityDefs = handle.db.select().from(schema.qualityDefinition).all();
    expect(qualityDefs.length).toBe(36);
    const defs = handle.db.select().from(schema.indexerDefinition).all();
    expect(defs.some((d) => d.key === "memory")).toBe(true);
    const jobs = handle.db.select().from(schema.jobDefinition).all();
    expect(jobs.some((j) => j.key === "system.healthCheck")).toBe(true);
    handle.close();
  });
});
