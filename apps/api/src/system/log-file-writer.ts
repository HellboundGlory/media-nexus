// SPDX-License-Identifier: MIT
import { appendFileSync, createReadStream, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { ApiError } from "@medianexus/shared";

/**
 * SON-035 — durable, rotating log FILES on disk, complementing the in-memory `LogBuffer`
 * (which a restart clears). The two are deliberately separate: `LogBuffer` serves the fast
 * live-tail UI view; `LogFileWriter` gives crash-diagnosing history that survives a restart.
 *
 * Path is FIXED at `resolve(process.cwd(), "data", "logs")` (same `data/` persisted-volume root
 * convention as `resolve(process.cwd(), "data", "downloads")` / `.../media/movies`). It cannot be
 * a Settings `system.*` key: `RingBufferLogger` is constructed in main.ts before Nest DI /
 * ConfigService / the DB exist, so it can't consult a DB-backed config at that point. Rotation
 * (size-based, ~5MB) and retention (keep 5 rotated files) are fixed constants for the same
 * reason — no Settings UI fields.
 *
 * Hand-rolled (no winston/pino/etc.), same style as `LogBuffer` and `BackupService`'s own file
 * management. The format is a human-readable download target, not something this app parses
 * back, so no escaping is applied beyond joining the four fields with `|`.
 */

const CURRENT = "medianexus.txt";
const rotatedName = (i: number): string => `medianexus.${i}.txt`;
const isLogFileName = (n: string): boolean => n === CURRENT || /^medianexus\.\d+\.txt$/.test(n);

const DEFAULT_DIR = resolve(process.cwd(), "data", "logs");
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export interface LogFileInfo {
  name: string;
  sizeBytes: number;
  createdAt: string;
}

/** Handle returned by `openDownload()` for the download endpoint. */
export interface LogFileDownload {
  stream: Readable;
  name: string;
}

export class LogFileWriter {
  private readonly currentPath: string;

  constructor(
    private readonly dir = DEFAULT_DIR,
    private readonly maxBytes = DEFAULT_MAX_BYTES,
    private readonly retain = 5,
  ) {
    mkdirSync(this.dir, { recursive: true });
    this.currentPath = join(this.dir, CURRENT);
  }

  /** Append one already-redacted line to the current file, rotating when it crosses the size
   *  threshold. Re-stats the file at each append, so a pre-existing file from before a restart
   *  is counted correctly (rotation math never assumes it started at zero). */
  append(level: string, context: string, message: string): void {
    appendFileSync(this.currentPath, `${new Date().toISOString()}|${level}|${context}|${message}\n`);
    if (statSync(this.currentPath).size >= this.maxBytes) this.rotate();
  }

  /** logrotate-style shift: drop the oldest rotated file, shift the rest down one, promote the
   *  current file to `.1`. The current file is recreated fresh by the next append. */
  private rotate(): void {
    const oldest = join(this.dir, rotatedName(this.retain));
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let i = this.retain - 1; i >= 1; i--) {
      const src = join(this.dir, rotatedName(i));
      if (existsSync(src)) renameSync(src, join(this.dir, rotatedName(i + 1)));
    }
    if (existsSync(this.currentPath)) renameSync(this.currentPath, join(this.dir, rotatedName(1)));
  }

  /** Physical log files currently on disk, newest first (current file + rotated backups). */
  list(): LogFileInfo[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter(isLogFileName)
      .map((name) => ({ name, stat: statSync(join(this.dir, name)) }))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
      .map((f) => ({ name: f.name, sizeBytes: f.stat.size, createdAt: f.stat.mtime.toISOString() }));
  }

  /** Validate + resolve a listed log file for download, returning a read stream. */
  openDownload(name: string): LogFileDownload {
    const srcPath = this.resolveWithin(name);
    if (!existsSync(srcPath)) throw new ApiError({ code: "NOT_FOUND", message: `Log file not found: ${basename(name)}` });
    return { stream: createReadStream(srcPath), name: basename(srcPath) };
  }

  /** Resolve a user-supplied name to a path strictly inside the logs directory, rejecting
   *  traversal and anything that isn't a recognized log filename. Mirrors BackupService's
   *  `resolveWithin` exactly (the two are security-critical and intentionally duplicate the
   *  ~15-line guard rather than extracting a helper, since the filename validators differ).
   *  Validation failures are 400s (not 404s) so we never leak filesystem structure. */
  private resolveWithin(name: string): string {
    const base = basename(name);
    if (base !== name || base === "" || base === "." || base === "..") {
      throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid log file name" });
    }
    if (!isLogFileName(base)) throw new ApiError({ code: "VALIDATION_ERROR", message: "Not a recognized log file" });
    const root = resolve(this.dir);
    const resolved = resolve(root, base);
    if (!resolved.startsWith(root + sep)) throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid log file path" });
    return resolved;
  }
}

/**
 * Module-level singleton shared by the custom Nest logger (main.ts) and the /system/log-files
 * endpoint — the same instance `RingBufferLogger.capture()` writes to is the one served back
 * for download, so the two always agree.
 */
export const logFileWriter = new LogFileWriter();
