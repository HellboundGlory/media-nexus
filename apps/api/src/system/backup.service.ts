// SPDX-License-Identifier: MIT
import { Inject, Injectable } from "@nestjs/common";
import { mkdirSync, readdirSync, statSync, unlinkSync, type Stats } from "node:fs";
import { join } from "node:path";
import type { DbHandle } from "@medianexus/database";
import { DB_HANDLE_TOKEN } from "../db/database.module";
import { ConfigService } from "./config.service";

const FILE_PREFIX = "medianexus-backup-";
const FILE_SUFFIX = ".sqlite3";

export interface BackupFileInfo {
  name: string;
  sizeBytes: number;
  createdAt: string;
}

export type BackupResult =
  | { created: string; sizeBytes: number; trimmed: string[] }
  | { skipped: true; reason: string };

/**
 * Backup (roadmap P1, gap report B9): SQLite + WAL + no backup is a one-disk-failure-from-
 * total-loss configuration. Uses `DbHandle.backup()` (SQLite's native online-backup API,
 * safe on a live connection with in-flight writes — no manual checkpoint needed).
 *
 * No companion config export: the backup file already contains the full `setting`/
 * `indexer`/`download_client` tables in plaintext (credentials are plaintext at rest
 * already, gap report J9) — a separate export would just be another plaintext-credentials
 * artifact to manage, with no restore capability the DB file doesn't already provide.
 *
 * Concurrency: `job_definition.concurrencyLimit` (seeded as 1 for this job) is enforced
 * generically by `JobEngine.drain()` (roadmap P1, gap report B11) — a scheduled fire racing
 * a manual trigger can no longer both reach `running` for the same jobKey, so this service
 * no longer needs its own in-flight guard.
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

    mkdirSync(backupPath, { recursive: true });
    const name = `${FILE_PREFIX}${new Date().toISOString().replace(/[:.]/g, "-")}${FILE_SUFFIX}`;
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

  private trim(backupPath: string, retentionCount: number): string[] {
    const files = this.readBackups(backupPath);
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
