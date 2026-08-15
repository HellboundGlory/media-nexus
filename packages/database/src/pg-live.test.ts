// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { createDb, type Db } from "../src/connection";
import { schema } from "../src/schema";
import { seedStatic } from "../src/seed";

const URL = process.env.PG_TEST_URL ?? "postgres://test:test@127.0.0.1:15432/mn_test";

/**
 * Live Postgres smoke test — verifies the Stage 1 foundation against a real server:
 * migrations apply, static seed runs, and a non-JSON query round-trips through the app's
 * `Db` surface via the approved boundary cast. It deliberately queries `quality_definition`
 * (integer/text columns only) because SQLite's `json` column mapper JSON.parses on read,
 * which double-decodes Postgres's already-parsed JSONB — that boundary is exactly the
 * documented Stage-2 call-site work (NOT fixable here without changing the SQLite-specific
 * mapper behavior, which is out of scope for the "zero SQLite change" Stage 1).
 *
 * Skipped unless a reachable Postgres is present (guarded by PG_TEST_URL being set by an
 * operator; skipped in CI otherwise so the suite stays green without a live server).
 */
describe.skipIf(!process.env.PG_TEST_URL)("live PostgreSQL (best-effort, guarded by PG_TEST_URL)", () => {
  it("applies migrations, seeds, and round-trips JSONB and non-JSON queries through the app Db surface", async () => {
    const h = createDb(URL);
    await h.runMigrations();
    await seedStatic(h.db as Db);

    // quality_definition is text/integer only — no JSON mapper involved, so this proves the
    // full migration + seed + query path works end-to-end on real Postgres via the boundary cast.
    const defs = (await h.db.select().from(schema.qualityDefinition)) as { id: number; title: string }[];
    expect(defs.length).toBe(36);
    expect(defs.some((d) => d.title.length > 0)).toBe(true);

    // quality_profile has a jsonb `items` column. In Stage 1 this DROPPED into the SQLite json
    // mapper (it JSON.parses on read, double-decoding pg's already-parsed JSONB). Stage 2's
    // per-Pool type-parser override (json/jsonb OIDs → raw text) fixes that at the wire level,
    // so the shared mapper now parses exactly once. Assert the JSONB round-trips through the
    // SQLite-typed `Db` surface.
    const known = (await h.db.select().from(schema.qualityProfile)) as { name: string; items: unknown }[];
    expect(known.length).toBeGreaterThan(0);
    const first = known[0];
    expect(Array.isArray(first.items)).toBe(true);
    const items = first.items as number[];
    expect(items.length).toBeGreaterThan(0);
    // items are ordered quality registry ids (numbers) — proves the JSONB array round-tripped intact.
    expect(items.every((n) => typeof n === "number")).toBe(true);

    await h.close();
  });
});
