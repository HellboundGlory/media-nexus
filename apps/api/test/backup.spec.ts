// SPDX-License-Identifier: MIT
/**
 * Roadmap P1 (gap report B9): SQLite + WAL + no backup was a one-disk-failure-from-
 * total-loss configuration. Uses the real file-backed createDb()/runMigrations() fixture
 * (same pattern as root-folders.spec.ts) so `.backup()` is exercised against a real
 * on-disk database, not a mock.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, schema, type DbHandle } from "@medianexus/database";
import { BackupService } from "../src/system/backup.service";
import { ConfigService } from "../src/system/config.service";

const dir = mkdtempSync(join(tmpdir(), "mn-backup-"));
const handles: DbHandle[] = [];
afterAll(() => { for (const h of handles) h.close(); });

let counter = 0;
async function freshDb() {
  const handle = createDb(join(dir, `bk-${counter++}.db`));
  handle.runMigrations();
  handles.push(handle);
  return handle;
}

// Concurrency (two system.backup runs racing) is enforced generically by JobEngine.drain()
// (roadmap P1, gap report B11) — see packages/jobs/src/engine.test.ts's concurrencyLimit
// tests, not BackupService's own responsibility anymore.
describe("BackupService", () => {
  it("no-ops cleanly when system.backupPath is not configured", async () => {
    const handle = await freshDb();
    const svc = new BackupService(handle, new ConfigService(handle.db));
    const result = await svc.run();
    expect(result).toEqual({ skipped: true, reason: "system.backupPath is not configured" });
  });

  it("creates a real, reopenable SQLite backup file and lists it", async () => {
    const handle = await freshDb();
    const cfg = new ConfigService(handle.db);
    const backupPath = mkdtempSync(join(dir, "dest-"));
    await cfg.upsert({ "system.backupPath": backupPath });
    await handle.db.insert(schema.movie).values({
      id: "m1", tmdbId: 99, title: "Backed Up Movie", releaseDate: "2020-01-01", status: "released",
      minimumAvailability: "released", monitored: true, qualityProfileId: null, rootFolderPath: "",
      images: [], tags: [], hasFile: false, addedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as never);

    const svc = new BackupService(handle, cfg);
    const result = await svc.run();
    expect("created" in result).toBe(true);
    if (!("created" in result)) throw new Error("expected a created backup");
    expect(result.sizeBytes).toBeGreaterThan(0);

    const reopened = createDb(join(backupPath, result.created));
    handles.push(reopened);
    const rows = await reopened.db.select().from(schema.movie);
    expect(rows.map((r) => r.id)).toEqual(["m1"]);

    const listed = await svc.list();
    expect(listed.map((f) => f.name)).toEqual([result.created]);
  });

  it("trims backups beyond the configured retention count", async () => {
    const handle = await freshDb();
    const cfg = new ConfigService(handle.db);
    const backupPath = mkdtempSync(join(dir, "dest-"));
    await cfg.upsert({ "system.backupPath": backupPath, "system.backupRetentionCount": 2 });
    const svc = new BackupService(handle, cfg);

    const created: string[] = [];
    for (let i = 0; i < 3; i++) {
      const result = await svc.run();
      if (!("created" in result)) throw new Error("expected a created backup");
      created.push(result.created);
      await new Promise((r) => setTimeout(r, 5)); // ensure distinct mtimes
    }

    const listed = await svc.list();
    expect(listed).toHaveLength(2);
  });
});
