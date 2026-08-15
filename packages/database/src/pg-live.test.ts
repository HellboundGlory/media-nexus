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
  it("applies migrations, seeds, and round-trips a non-JSON query through the app Db surface", async () => {
    const h = createDb(URL);
    await h.runMigrations();
    await seedStatic(h.db as Db);

    // quality_definition is text/integer only — no JSON mapper involved, so this proves the
    // full migration + seed + query path works end-to-end on real Postgres via the boundary cast.
    const defs = (await h.db.select().from(schema.qualityDefinition)) as { id: number; title: string }[];
    expect(defs.length).toBe(36);
    expect(defs.some((d) => d.title.length > 0)).toBe(true);

    // quality_profile has a jsonb `items` column — querying it DROPS into the SQLite json
    // mapper and fails (documented Stage-2 boundary), so we assert ONLY the non-JSON seat.
    await h.close();
  });
});
