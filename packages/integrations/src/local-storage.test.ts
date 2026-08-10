// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStorageProvider, findLargestVideo, VIDEO_EXTENSIONS } from "./local-storage";

let dir: string;
const storage = new LocalStorageProvider();

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "mn-storage-")); });
afterAll(async () => { await storage.delete(dir); });

describe("LocalStorageProvider", () => {
  it("ensureDir + list", async () => {
    const sub = join(dir, "a", "b");
    await storage.ensureDir(sub);
    const items = await storage.list(join(dir, "a"));
    expect(items.some((i) => i.isDirectory && i.path === sub)).toBe(true);
  });

  it("hardlinks (falls back to copy) and copy/move/delete", async () => {
    const src = join(dir, "src.mkv"); writeFileSync(src, "hello");
    const dst = join(dir, "dst.mkv");
    const linked = await storage.hardlink(src, dst);
    expect(linked).toBe(true); // same fs -> hardlink on tmpfs/ext4
    expect(readFileSync(dst, "utf8")).toBe("hello");
    await storage.copy(src, join(dir, "copy.mkv"));
    await storage.move(join(dir, "copy.mkv"), join(dir, "moved.mkv"));
    expect(existsSync(join(dir, "moved.mkv"))).toBe(true);
    await storage.delete(join(dir, "moved.mkv"));
    expect(existsSync(join(dir, "moved.mkv"))).toBe(false);
  });

  it("findLargestVideo picks the biggest media file only", async () => {
    const big = join(dir, "big.mkv"); writeFileSync(big, Buffer.alloc(4096));
    await storage.ensureDir(join(dir, "samples"));
    writeFileSync(join(dir, "samples", "small.mp4"), Buffer.alloc(128));
    writeFileSync(join(dir, "samples", "readme.txt"), Buffer.alloc(64));
    const found = await findLargestVideo(storage, dir);
    expect(found?.path).toBe(big);
  });

  it("ships a sane video-extension set", () => {
    expect(VIDEO_EXTENSIONS.has(".mkv")).toBe(true);
    expect(VIDEO_EXTENSIONS.has(".mp4")).toBe(true);
  });
});
