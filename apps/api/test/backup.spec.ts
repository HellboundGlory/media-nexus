// SPDX-License-Identifier: MIT
/**
 * Roadmap P1 (gap report B9): SQLite + WAL + no backup was a one-disk-failure-from-
 * total-loss configuration. Uses the real file-backed createDb()/runMigrations() fixture
 * (same pattern as root-folders.spec.ts) so `.backup()` is exercised against a real
 * on-disk database, not a mock.
 */
import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
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

  // ---- Restore / upload / download (BACKUPRESTORE-1) ----

  it("restores a backup over the live DB end to end and records a durable audit row", async () => {
    // Lifecycle handled manually here (the live handle is closed mid-test to simulate the
    // process restart), so don't use freshDb()'s auto-close registry.
    const dbFile = join(dir, `rt-${counter++}.db`);
    const handle = createDb(dbFile);
    handle.runMigrations();
    const cfg = new ConfigService(handle.db);
    const backupPath = mkdtempSync(join(dir, "restore-dest-"));
    await cfg.upsert({ "system.backupPath": backupPath });
    const svc = new BackupService(handle, cfg);

    // State one: a single movie.
    await handle.db.insert(schema.movie).values({ id: "m1", tmdbId: 1, title: "State One", releaseDate: "2020-01-01", status: "released", minimumAvailability: "released", monitored: true, qualityProfileId: null, rootFolderPath: "", images: [], tags: [], hasFile: false, addedAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as never);
    const b1 = (await svc.run()) as { created: string };

    // State two: a second movie added after the backup was taken.
    await handle.db.insert(schema.movie).values({ id: "m2", tmdbId: 2, title: "State Two", releaseDate: "2020-01-01", status: "released", minimumAvailability: "released", monitored: true, qualityProfileId: null, rootFolderPath: "", images: [], tags: [], hasFile: false, addedAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as never);

    const res = await svc.restore(b1.created);
    expect(res.restored).toBe(b1.created);
    expect(res.safetyBackup).toMatch(/safety-/);

    // Safety copy of state two was created and is listed (trim-exempt).
    const listed = await svc.list();
    expect(listed.map((f) => f.name)).toContain(res.safetyBackup);

    // The live DB file was swapped: reopen the same path fresh (the still-open handle points
    // at the orphaned pre-restore inode) and confirm state one is back, state two is gone.
    handle.close();
    const reopened = createDb(dbFile);
    const after = (await reopened.db.select().from(schema.movie)).map((r) => r.id);
    expect(after).toEqual(["m1"]);

    // The durable audit row for this restore landed in the restored DB and survives reopen.
    const audit = await reopened.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "backup.restore"));
    expect(audit.length).toBeGreaterThan(0);
    reopened.close();
  });

  it("rejects path traversal and non-backup names on restore and download (400, not 404)", async () => {
    const handle = await freshDb();
    const cfg = new ConfigService(handle.db);
    const backupPath = mkdtempSync(join(dir, "trav-"));
    await cfg.upsert({ "system.backupPath": backupPath });
    const svc = new BackupService(handle, cfg);

    for (const bad of ["../../../etc/passwd", "/etc/passwd", "medianexus-backup-../../x.sqlite3"]) {
      await expect(svc.restore(bad)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      await expect(svc.openDownload(bad)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    // A well-formed name that simply isn't on disk is a 404, not a validation error.
    await expect(svc.restore("medianexus-backup-missing.sqlite3")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(svc.openDownload("medianexus-backup-missing.sqlite3")).rejects.toMatchObject({ code: "NOT_FOUND" });
    // No stray files were created by the rejected attempts.
    expect(readdirSync(backupPath)).toHaveLength(0);
  });

  it("rejects non-SQLite uploads and foreign-schema backups, leaving the live DB untouched", async () => {
    const handle = await freshDb();
    const cfg = new ConfigService(handle.db);
    const backupPath = mkdtempSync(join(dir, "up-"));
    await cfg.upsert({ "system.backupPath": backupPath });
    const svc = new BackupService(handle, cfg);

    await expect(svc.upload(Buffer.from("definitely not a sqlite database"), "junk.db")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(readdirSync(backupPath)).toHaveLength(0);

    // A corrupt file placed in the backup folder is rejected by restore.
    writeFileSync(join(backupPath, "medianexus-backup-corrupt.sqlite3"), Buffer.from("garbage"));
    await expect(svc.restore("medianexus-backup-corrupt.sqlite3")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    // A genuine SQLite file with a foreign schema (no setting table) is rejected too.
    const foreign = new Database(join(backupPath, "medianexus-backup-foreign.sqlite3"));
    foreign.exec("CREATE TABLE random_thing (id INTEGER);");
    foreign.close();
    await expect(svc.restore("medianexus-backup-foreign.sqlite3")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    // Live DB untouched throughout.
    const after = await handle.db.select().from(schema.setting);
    expect(after.length).toBeGreaterThan(0);
  });

  it("accepts a valid uploaded backup and lists it", async () => {
    const handle = await freshDb();
    const cfg = new ConfigService(handle.db);
    const backupPath = mkdtempSync(join(dir, "upl-"));
    await cfg.upsert({ "system.backupPath": backupPath });
    const svc = new BackupService(handle, cfg);

    const made = await svc.run();
    if (!("created" in made)) throw new Error("expected a created backup");
    const buf = readFileSync(join(backupPath, made.created));

    const info = await svc.upload(buf, "my library backup.db");
    expect(info.name).toMatch(/^medianexus-backup-uploaded-/);
    expect(info.sizeBytes).toBeGreaterThan(0);
    const listed = await svc.list();
    expect(listed.map((f) => f.name)).toContain(info.name);
  });

  it("never removes uploaded or safety backups during retention trim", async () => {
    const handle = await freshDb();
    const cfg = new ConfigService(handle.db);
    const backupPath = mkdtempSync(join(dir, "trim-"));
    await cfg.upsert({ "system.backupPath": backupPath, "system.backupRetentionCount": 2 });
    const svc = new BackupService(handle, cfg);

    const made1 = await svc.run();
    // Capture the (soon-to-be-trimmed) backup bytes now, before later runs delete them.
    if (!("created" in made1)) throw new Error("expected a created backup");
    const buf = readFileSync(join(backupPath, made1.created));
    const made2 = await svc.run();
    const made3 = await svc.run();
    if (!("created" in made2) || !("created" in made3)) throw new Error("expected a created backup");
    const made4 = await svc.run();
    if (!("created" in made4)) throw new Error("expected a created backup");

    // Add exempt-named real backups (uploaded + safety) directly.
    const uploaded = "medianexus-backup-uploaded-keep.sqlite3";
    const safety = "medianexus-backup-safety-keep.sqlite3";
    writeFileSync(join(backupPath, uploaded), buf);
    writeFileSync(join(backupPath, safety), buf);

    // A 5th run trims regular backups to retentionCount (2), leaving the exempt ones alone.
    const made5 = await svc.run();
    if (!("created" in made5)) throw new Error("expected a created backup");

    const names = (await svc.list()).map((f) => f.name);
    const normal = names.filter((n) => n.startsWith("medianexus-backup-") && !n.includes("-uploaded-") && !n.includes("-safety-"));
    expect(normal).toHaveLength(2);
    expect(names).toContain(uploaded);
    expect(names).toContain(safety);
    expect(existsSync(join(backupPath, uploaded))).toBe(true);
    expect(existsSync(join(backupPath, safety))).toBe(true);
  });
});
