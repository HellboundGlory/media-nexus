// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, type Db } from "../src/connection";
import { schema } from "../src/schema";
import { seedStatic } from "../src/seed";

const URL = process.env.PG_TEST_URL ?? "postgres://test:test@127.0.0.1:15432/mn_test";

/**
 * Live Postgres smoke test — verifies the Stage 1 foundation against a real server:
 * migrations apply, static seed runs, and JSONB + non-JSON queries round-trip through the
 * app's `Db` surface via the approved boundary cast.
 *
 * Stage 2 (roadmap P2 item 12) additionally verifies two things that only make sense on a
 * real Postgres: (1) that a Postgres transaction callback rolls back atomically when any
 * statement throws (the async-body path that the sync SQLite transaction can't test), and
 * (2) that the `jsonb_extract_path_text` expression used in the compat/statistics path
 * (see IndexersService.statistics) evaluates correctly now that json/jsonb OIDs are
 * returned as raw text by the type-parser override.
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
    // type-parser override (json/jsonb OIDs → raw text) fixes that at the wire level, so the
    // shared mapper now parses exactly once. Assert the JSONB round-trips through the SQLite-typed
    // `Db` surface.
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

  it("rolls back a Postgres transaction atomically when a statement throws", async () => {
    const h = createDb(URL);
    await h.runMigrations();

    const probeMediaId = "pg-tx-rollback";
    // Precondition: no leftover rows from a previous (failed) run.
    const before = await h.db
      .select({ id: schema.mediaAvailability.id })
      .from(schema.mediaAvailability)
      .where(eq(schema.mediaAvailability.mediaId, probeMediaId));
    expect(before.length).toBe(0);

    // The Postgres async transaction body must be atomic: insert two rows inside a tx,
    // then throw — neither should persist.
    await expect(
      h.db.transaction(async (tx) => {
        await tx.insert(schema.mediaAvailability).values({
          id: "av-rollback-1", mediaType: "movie", mediaId: probeMediaId, status: "unknown",
        });
        await tx.insert(schema.mediaAvailability).values({
          id: "av-rollback-2", mediaType: "series", mediaId: probeMediaId, status: "unknown",
        });
        throw new Error("boom inside transaction");
      }),
    ).rejects.toThrow("boom inside transaction");

    const after = await h.db
      .select({ id: schema.mediaAvailability.id })
      .from(schema.mediaAvailability)
      .where(eq(schema.mediaAvailability.mediaId, probeMediaId));
    expect(after.length).toBe(0);

    await h.close();
  });

  it("rolls back a Postgres transaction's partial UPDATE when a later statement throws", async () => {
    const h = createDb(URL);
    await h.runMigrations();

    // Seed one row, keep a stable id for the update, and make it idempotent.
    const probeId = "pg-tx-rollback-upd";
    await h.db.delete(schema.movie).where(eq(schema.movie.id, probeId));
    const now = new Date().toISOString();
    await h.db.insert(schema.movie).values({
      id: probeId,
      title: "Rollback Movie",
      overview: "",
      status: "announced",
      releaseDate: null,
      monitored: true,
      qualityProfileId: null,
      rootFolderPath: "",
      minimumAvailability: "announced",
      genres: [],
      images: [],
      tags: [],
      hasFile: false,
      addedAt: now,
      updatedAt: now,
    });

    await expect(
      h.db.transaction(async (tx) => {
        // Two writes: an UPDATE (would persist if not atomic) then a failing insert.
        await tx.update(schema.movie).set({ title: "Rollback Movie - CHANGED", updatedAt: now }).where(eq(schema.movie.id, probeId));
        await tx.insert(schema.movie).values({
          id: "pg-tx-rollback-upd-dup",
          title: "Dup",
          overview: "",
          status: "announced",
          releaseDate: null,
          monitored: false,
          qualityProfileId: null,
          rootFolderPath: "",
          minimumAvailability: "announced",
          genres: [],
          images: [],
          tags: [],
          hasFile: false,
          addedAt: now,
          updatedAt: now,
        });
      }),
    ).rejects.toThrow();

    const after = (await h.db.select({ title: schema.movie.title }).from(schema.movie).where(eq(schema.movie.id, probeId)))[0];
    expect(after?.title).toBe("Rollback Movie"); // unchanged — the UPDATE rolled back with the tx

    await h.close();
  });

  it("evaluates the jsonb_extract_path_text expression used by the statistics path", async () => {
    const h = createDb(URL);
    await h.runMigrations();

    const probeId = "pg-jsonpatch";
    // Idempotent against a leftover row from an earlier run (unique pk).
    await h.db.delete(schema.historyEntry).where(eq(schema.historyEntry.id, probeId));
    await h.db.insert(schema.historyEntry).values({
      id: probeId,
      mediaType: "movie",
      mediaId: "m1",
      action: "grabbed",
      data: { indexerId: "idx-42", title: "Some Movie 2020" },
      createdAt: new Date().toISOString(),
    });

    // Mirrors IndexersService.statistics()'s Postgres branch: jsonb_extract_path_text over the
    // jsonb column. With the type-parser override the data column comes back as a JS object
    // after the shared SQLite mapper parses it once, and the SQL expression returns the text id.
    const rows = (await h.db
      .select({
        indexerId: sql<string>`jsonb_extract_path_text(${schema.historyEntry.data}, 'indexerId')`,
        createdAt: schema.historyEntry.createdAt,
      })
      .from(schema.historyEntry)
      .where(eq(schema.historyEntry.id, probeId))) as { indexerId: string; createdAt: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0].indexerId).toBe("idx-42");

    await h.close();
  });
});
