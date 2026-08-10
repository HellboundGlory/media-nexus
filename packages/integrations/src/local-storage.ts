// SPDX-License-Identifier: MIT
/** Local filesystem storage provider — the default backing for media import/organization. */
import { promises as fs } from "node:fs";
import { resolve, basename, join } from "node:path";
import type { StorageContract, StorageItem } from "./contracts";

export class LocalStorageProvider implements StorageContract {
  readonly key = "local";

  async ensureDir(path: string): Promise<void> {
    await fs.mkdir(path, { recursive: true });
  }

  async list(path: string): Promise<StorageItem[]> {
    const entries = await fs.readdir(path, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[]);
    const out: StorageItem[] = [];
    for (const e of entries) {
      const full = join(path, e.name);
      let size = 0;
      try {
        if (e.isFile()) size = (await fs.stat(full)).size;
      } catch { /* ignore */ }
      out.push({ path: full, size, isDirectory: e.isDirectory() });
    }
    return out;
  }

  async move(src: string, dst: string): Promise<void> {
    await fs.rename(src, dst).catch(async () => {
      await fs.copyFile(src, dst);
      await fs.rm(src, { recursive: true, force: true });
    });
  }

  async copy(src: string, dst: string): Promise<void> {
    await fs.copyFile(src, dst);
  }

  /** Hardlink when possible (same filesystem); falls back to a real copy. */
  async hardlink(src: string, dst: string): Promise<boolean> {
    try {
      await fs.link(src, dst);
      return true;
    } catch {
      await fs.copyFile(src, dst);
      return false;
    }
  }

  async delete(path: string): Promise<void> {
    await fs.rm(path, { recursive: true, force: true });
  }

  async diskFree(path: string): Promise<{ free: number; total: number }> {
    try {
      const s = await fs.statfs(resolve(path));
      return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
    } catch {
      return { free: -1, total: -1 };
    }
  }
}

/** Video media extensions considered importable. */
export const VIDEO_EXTENSIONS = new Set([".mkv", ".mp4", ".avi", ".mov", ".m4v", ".ts", ".wmv", ".webm", ".flv", ".mpg", ".mpeg"]);

/** Depth-first search for the largest video file under `root`. */
export async function findLargestVideo(storage: StorageContract, root: string): Promise<{ path: string; size: number } | null> {
  async function walk(dir: string): Promise<{ path: string; size: number }[]> {
    const items = await storage.list(dir).catch(() => [] as StorageItem[]);
    const files: { path: string; size: number }[] = [];
    for (const it of items) {
      if (it.isDirectory) {
        files.push(...(await walk(it.path)));
      } else if (VIDEO_EXTENSIONS.has(extOf(it.path))) {
        files.push({ path: it.path, size: it.size });
      }
    }
    return files;
  }
  const all = await walk(root);
  if (all.length === 0) return null;
  all.sort((a, b) => b.size - a.size);
  return all[0];
}

function extOf(p: string): string {
  const i = p.lastIndexOf(".");
  return i >= 0 ? p.slice(i).toLowerCase() : "";
}

export const safeName = (s: string) => basename(s).replace(/[^A-Za-z0-9 _()[\]-]/g, "");
