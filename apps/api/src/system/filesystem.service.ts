// SPDX-License-Identifier: MIT
import { Injectable } from "@nestjs/common";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** One subdirectory entry in a filesystem listing. */
export interface FilesystemDirectory {
  name: string;
  path: string;
}

/** GET /system/filesystem response — what was actually listed (may differ from the requested
 *  path due to the nearest-readable-ancestor fallback), its parent (null at the real root), and
 *  the directories it contains. */
export interface FilesystemListing {
  path: string;
  parent: string | null;
  directories: FilesystemDirectory[];
}

/**
 * UNI-012 — read-only host filesystem browser for the path pickers. Full-filesystem, NO
 * jail/restricted root (per Hellbound's explicit decision): browse anywhere the container/process
 * can see, exactly like Radarr/Sonarr (their browser starts at `/` and lists `bin`/`etc`/`home`/
 * everything). The `AdminGuard` on the endpoint is the security boundary, not a path allowlist.
 *
 * Resilience rules (why this is its own service, not a raw `readdirSync` in the controller): a
 * request may carry a path that doesn't exist / isn't a directory / isn't readable (a user typing
 * `/media/mov` character-by-character transiently produces exactly that). Rather than 500, we walk
 * UP to the nearest existing readable ancestor and list THAT; the response `path` tells the caller
 * what was actually listed.
 *
 * Per-entry we only surface subdirectories via the directory entry itself (Dirent — from the
 * directory read, no per-subdir stat/read), so an unreadable subdirectory is skipped rather than
 * failing the whole request.
 *
 * Directories only — none of the five target path fields needed a file picker.
 */
@Injectable()
export class FilesystemService {
  list(requested?: string): FilesystemListing {
    const want = requested && requested.trim() ? requested.trim() : "/";
    const resolvedPath = this.resolveToReadableDir(want);
    return {
      path: resolvedPath,
      parent: this.parentOf(resolvedPath),
      directories: this.readDirectories(resolvedPath),
    };
  }

  /** Normalize to an absolute path, then walk UP to the nearest existing readable directory. */
  private resolveToReadableDir(want: string): string {
    let p = resolve(want);
    for (;;) {
      try {
        if (existsSync(p) && statSync(p).isDirectory()) {
          readdirSync(p); // throws EACCES if the process can't read it — falls to the walk-up
          return p;
        }
      } catch {
        /* unreadable/nonexistent — walk up */
      }
      const parent = dirname(p);
      if (parent === p) return p; // reached the real filesystem root
      p = parent;
    }
  }

  private parentOf(p: string): string | null {
    const parent = dirname(p);
    return parent === p ? null : parent;
  }

  private readDirectories(p: string): FilesystemDirectory[] {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(p, { withFileTypes: true });
    } catch {
      return []; // already validated readable above; defensive only
    }
    const dirs: FilesystemDirectory[] = [];
    for (const entry of entries) {
      if (this.isDirectoryEntry(join(p, entry.name), entry)) {
        dirs.push({ name: entry.name, path: join(p, entry.name) });
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    return dirs;
  }

  /** Whether a directory entry is (or symlinks to) a directory. A plain `Dirent`'s
   *  `isDirectory()` does NOT resolve symlinks — `readdirSync(..., { withFileTypes: true })`
   *  never follows them, so a symlinked directory reports `isSymbolicLink(): true` /
   *  `isDirectory(): false` and would be silently lost (a real-world *arr deployment pattern:
   *  root/recycle/downloads folders pointed at a symlinked NAS mount). For symlinks we `statSync`
   *  the resolved target, which DOES follow the link. A broken/dangling or unreadable symlink is
   *  skipped silently (not an error) — same graceful-degradation philosophy as the rest of the
   *  service. */
  private isDirectoryEntry(path: string, entry: import("node:fs").Dirent): boolean {
    if (entry.isDirectory()) return true;
    if (entry.isSymbolicLink()) {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false; // dangling / unreadable symlink — skip silently
      }
    }
    return false; // a plain file (or other non-dir) — excluded
  }
}
