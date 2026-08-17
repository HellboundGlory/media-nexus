// SPDX-License-Identifier: MIT
import { Inject, Injectable } from "@nestjs/common";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import Database from "better-sqlite3";
import { ApiError, getCorrelationId, newEntityId } from "@medianexus/shared";
import type { DbHandle } from "@medianexus/database";
import { validateBackupFile } from "@medianexus/database";
import { DB_HANDLE_TOKEN } from "../db/database.module";
import { ConfigService } from "./config.service";

const FILE_PREFIX = "medianexus-backup-";
const FILE_SUFFIX = ".sqlite3";
// Trim-exempt markers embedded in backup filenames. `list()`/`trim()` already drive off a
// naming pattern, so marking exempt files by name needs no new DB table (BACKUPRESTORE-1):
//   - pre-restore safety copies of the live DB ("safety-") must survive a retention trim,
//   - uploaded off-box backups ("uploaded-") are deliberately-kept snapshots and must never
//     be deleted just because they're chronologically the oldest.
const SAFETY_MARKER = "safety-";
const UPLOADED_MARKER = "uploaded-";

function isTrimExempt(name: string): boolean {
  return name.includes(SAFETY_MARKER) || name.includes(UPLOADED_MARKER);
}

function isoStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export interface BackupFileInfo {
  name: string;
  sizeBytes: number;
  createdAt: string;
}

export type BackupResult =
  | { created: string; sizeBytes: number; trimmed: string[] }
  | { skipped: true; reason: string };

/** Handle returned by `openDownload()` for the download endpoint. */
export interface BackupDownload {
  stream: Readable;
  name: string;
}

/**
 * Backup + restore (roadmap P1, gap report B9; restore half = BACKUPRESTORE-1). `run()` and
 * `list()` stay unchanged; restore/download/upload are the in-app half of the story that
 * replaces the manual file-swap restore in docs/deployment/upgrade-and-migration.md.
 *
 * Restore swaps the chosen backup in over the live DB file, then the caller
 * (SystemController) closes the connection and exits the process so the host's
 * `restart: unless-stopped` relaunches the container — same mental model as Radarr's own
 * "Restore / Restart / Reload" dialog.
 */
@Injectable()
export class BackupService {
  constructor(
    @Inject(DB_HANDLE_TOKEN) private readonly handle: DbHandle,
    private readonly config: ConfigService,
  ) {}

  async run(): Promise<BackupResult> {
    const cfg = await this.config.get();
    const backupPath = cfg["system.backupPath"];
    if (!backupPath) return { skipped: true, reason: "system.backupPath is not configured" };

    // Postgres has no single-file online-backup API (SQLite-only; see createDb). A scheduled
    // backup job on a Postgres install must degrade gracefully instead of hard-failing the
    // whole job — pg_dump automation is intentionally out of scope (roadmap P2 item 12).
    if (this.handle.dialect === "postgres") {
      return { skipped: true, reason: "Backup is SQLite-only; use pg_dump for a Postgres database" };
    }

    mkdirSync(backupPath, { recursive: true });
    const name = `${FILE_PREFIX}${isoStamp()}${FILE_SUFFIX}`;
    const destPath = join(backupPath, name);
    await this.handle.backup(destPath);
    const sizeBytes = statSync(destPath).size;

    const trimmed = this.trim(backupPath, cfg["system.backupRetentionCount"]);
    return { created: name, sizeBytes, trimmed };
  }

  async list(): Promise<BackupFileInfo[]> {
    const cfg = await this.config.get();
    if (!cfg["system.backupPath"]) return [];
    return this.readBackups(cfg["system.backupPath"]).map((f) => ({ name: f.name, sizeBytes: f.stat.size, createdAt: f.stat.mtime.toISOString() }));
  }

  /**
   * Restore the named backup in place. The live SQLite database is swapped for the chosen
   * backup after validation; the process is expected to exit immediately after (the
   * controller handles the restart). Every step that can fail before the DB is touched —
   * dialect check, path-traversal check, file existence, schema-marker + integrity check —
   * runs first, so on any rejection the live database is provably untouched.
   */
  async restore(name: string): Promise<{ restored: string; safetyBackup: string }> {
    const cfg = await this.config.get();
    const backupPath = cfg["system.backupPath"];
    if (!backupPath) throw new ApiError({ code: "VALIDATION_ERROR", message: "system.backupPath is not configured" });
    this.assertSqliteOnly("Restore");

    const srcPath = this.resolveWithin(backupPath, name);
    if (!existsSync(srcPath)) throw new ApiError({ code: "NOT_FOUND", message: `Backup file not found: ${basename(name)}` });

    const livePath = this.handle.path;
    if (!livePath) throw new ApiError({ code: "UNPROCESSABLE", message: "Cannot restore into an in-memory database" });

    // Validate the restore source BEFORE touching the live DB.
    try {
      validateBackupFile(srcPath);
    } catch (err) {
      throw new ApiError({ code: "VALIDATION_ERROR", message: (err as Error).message });
    }

    mkdirSync(backupPath, { recursive: true });

    // Safety copy of the CURRENT live DB before the swap (native online-backup, safe on the
    // live connection; named trim-exempt so the retention trim never deletes it).
    const safetyName = `${FILE_PREFIX}${SAFETY_MARKER}${isoStamp()}${FILE_SUFFIX}`;
    await this.handle.backup(join(backupPath, safetyName));

    // Swap the backup into the live DB path. Copy to a temp in the same directory (works
    // across filesystems and keeps one atomic rename), stamp the DURABLE audit row into the
    // temp, then rename over the live path. Because rename replaces the directory entry, the
    // still-open connection keeps the OLD inode — any write landing in the brief pre-exit
    // window hits the orphaned file, never the restored one. Finally remove stale WAL/SHM
    // sidecars so old frames can't be replayed against the swapped-in file on next open.
    //
    // Audit is stamped into the temp *before* the rename so it lands in the file that BECOMES
    // the live DB (and thus survives restart). Writing it through the still-open connection
    // would put the row in the OLD inode, which is orphaned by the swap — exactly the
    // "not durable after restart" case the acceptance criterion forbids.
    const tmp = join(dirname(livePath), `.mn-restore-${randomUUID()}.tmp`);
    try {
      copyFileSync(srcPath, tmp);
      this.writeRestoreAudit(tmp, { restored: name, safetyBackup: safetyName });
      renameSync(tmp, livePath);
      for (const sidecar of [`${livePath}-wal`, `${livePath}-shm`]) {
        try {
          unlinkSync(sidecar);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        /* best-effort cleanup of a temp that may not exist */
      }
      throw err;
    }

    return { restored: name, safetyBackup: safetyName };
  }

  /**
   * Accept an uploaded backup into the backup folder (trim-exempt, so an off-box safety net
   * is never trimmed away). Validated the same way as restore — read-only open + schema
   * marker — BEFORE it is moved into place; a rejected upload never leaves a half-written
   * file in the backup folder.
   */
  async upload(buffer: Buffer, originalName: string): Promise<BackupFileInfo> {
    const cfg = await this.config.get();
    const backupPath = cfg["system.backupPath"];
    if (!backupPath) throw new ApiError({ code: "VALIDATION_ERROR", message: "system.backupPath is not configured" });
    this.assertSqliteOnly("Upload");

    mkdirSync(backupPath, { recursive: true });

    const tmpPath = join(backupPath, `${FILE_PREFIX}${UPLOADED_MARKER}.tmp-${randomUUID()}${FILE_SUFFIX}`);
    writeFileSync(tmpPath, buffer);
    try {
      validateBackupFile(tmpPath);
    } catch (err) {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* best-effort cleanup of the rejected temp */
      }
      throw new ApiError({ code: "VALIDATION_ERROR", message: `Not a valid MediaNexus backup: ${(err as Error).message}` });
    }

    const finalPath = this.pickUploadPath(backupPath, originalName);
    renameSync(tmpPath, finalPath);
    const st = statSync(finalPath);
    return { name: basename(finalPath), sizeBytes: st.size, createdAt: st.mtime.toISOString() };
  }

  /** Validate + resolve a listed backup for download, returning a read stream. */
  async openDownload(name: string): Promise<BackupDownload> {
    const cfg = await this.config.get();
    const backupPath = cfg["system.backupPath"];
    if (!backupPath) throw new ApiError({ code: "VALIDATION_ERROR", message: "system.backupPath is not configured" });
    this.assertSqliteOnly("Download");

    const srcPath = this.resolveWithin(backupPath, name);
    if (!existsSync(srcPath)) throw new ApiError({ code: "NOT_FOUND", message: `Backup file not found: ${basename(name)}` });
    return { stream: createReadStream(srcPath), name: basename(srcPath) };
  }

  private assertSqliteOnly(verb: string): void {
    if (this.handle.dialect === "postgres") {
      throw new ApiError({ code: "UNPROCESSABLE", message: `${verb} is SQLite-only; use pg_dump for a Postgres database` });
    }
  }

  /** Resolve a user-supplied name to a path strictly inside backupPath, rejecting traversal
   *  and anything that isn't a listed-backup filename. Validation failures are 400s (not
   *  404s) so we never leak filesystem structure. */
  private resolveWithin(backupPath: string, name: string): string {
    const base = basename(name);
    if (base !== name || base === "" || base === "." || base === "..") {
      throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid backup name" });
    }
    if (!base.startsWith(FILE_PREFIX) || !base.endsWith(FILE_SUFFIX)) {
      throw new ApiError({ code: "VALIDATION_ERROR", message: "Not a recognized MediaNexus backup file" });
    }
    const root = resolve(backupPath);
    const resolved = resolve(root, base);
    if (!resolved.startsWith(root + sep)) {
      throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid backup path" });
    }
    return resolved;
  }

  private pickUploadPath(backupPath: string, originalName: string): string {
    const raw = basename(originalName).replace(/\.[^.]+$/, "") || "backup";
    const slug = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "backup";
    let candidate = join(backupPath, `${FILE_PREFIX}${UPLOADED_MARKER}${slug}${FILE_SUFFIX}`);
    let n = 1;
    while (existsSync(candidate)) {
      candidate = join(backupPath, `${FILE_PREFIX}${UPLOADED_MARKER}${slug}-${n}${FILE_SUFFIX}`);
      n++;
    }
    return candidate;
  }

  /** Stamp a durable audit_log row into the restored DB file (a fresh read-write connection
   *  to the temp copy that is about to become the live DB). Opens/closes its own connection so
   *  the row is guaranteed on disk before the rename, and so a failure aborts the swap with the
   *  live DB untouched. */
  private writeRestoreAudit(filePath: string, details: Record<string, unknown>): void {
    let db: Database.Database;
    try {
      db = new Database(filePath);
    } catch (err) {
      throw new ApiError({ code: "INTERNAL", message: "Failed to open backup for audit", details: (err as Error).message });
    }
    try {
      db.prepare(
        "INSERT INTO audit_log (id, correlation_id, actor, action, entity_type, entity_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        newEntityId("audit_"),
        getCorrelationId() ?? null,
        "system",
        "backup.restore",
        null,
        null,
        JSON.stringify(details),
        new Date().toISOString(),
      );
    } catch (err) {
      throw new ApiError({ code: "INTERNAL", message: "Failed to record restore audit trail", details: (err as Error).message });
    } finally {
      db.close();
    }
  }

  private trim(backupPath: string, retentionCount: number): string[] {
    // Only non-exempt (normal scheduled/manual) backups count toward retention. Safety and
    // uploaded backups are deliberate and must survive trims.
    const files = this.readBackups(backupPath).filter((f) => !isTrimExempt(f.name));
    if (files.length <= retentionCount) return [];
    const toRemove = files.slice(retentionCount);
    for (const f of toRemove) unlinkSync(join(backupPath, f.name));
    return toRemove.map((f) => f.name);
  }

  /** Newest first. */
  private readBackups(backupPath: string): { name: string; stat: Stats }[] {
    const names = readdirSync(backupPath).filter((n) => n.startsWith(FILE_PREFIX) && n.endsWith(FILE_SUFFIX));
    return names
      .map((name) => ({ name, stat: statSync(join(backupPath, name)) }))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  }
}
