// SPDX-License-Identifier: MIT
/**
 * SON-035 — durable, rotating log files on disk. Covers the four behaviors that actually
 * matter for the finding:
 *   - content survives a restart (kill + new writer on the same dir — the whole point);
 *   - size-based rotation moves the current file to `.1` and starts a fresh one;
 *   - retention trim deletes files beyond the keep count (not just rename-into-oblivion);
 *   - openDownload rejects path traversal the same way BackupService does.
 * Redaction-in-file is asserted in logs.spec.ts (through RingBufferLogger, since that's where
 * the single redaction pass lives).
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogFileWriter } from "../src/system/log-file-writer";

describe("LogFileWriter (SON-035)", () => {
  it("appends to a real file whose content survives a restart (new writer on the same dir)", () => {
    const d = mkdtempSync(join(tmpdir(), "mn-restart-"));
    const w1 = new LogFileWriter(d);
    w1.append("info", "A", "before-restart line 1");
    w1.append("warn", "B", "before-restart line 2");

    // "Restart": a brand-new writer on the SAME directory must see the pre-existing file and
    // continue it, not start fresh.
    const w2 = new LogFileWriter(d);
    w2.append("error", "C", "after-restart line");

    const text = readFileSync(join(d, "medianexus.txt"), "utf8");
    expect(text).toContain("before-restart line 1");
    expect(text).toContain("before-restart line 2");
    expect(text).toContain("after-restart line");
    // Pre-restart lines are at the top (appended in order), the post-restart one last.
    expect(text.indexOf("before-restart line 1")).toBeLessThan(text.indexOf("after-restart line"));
  });

  it("rotates the current file once it crosses the size threshold (fresh current + .N history)", () => {
    const d = mkdtempSync(join(tmpdir(), "mn-rotate-"));
    // Tiny threshold (~90 bytes ≈ 2-3 lines/file) so a handful of appends force rotation;
    // keep 3 rotated files.
    const w = new LogFileWriter(d, 90, 3);
    // 5 appends: the first line's file rotates to `.1` well before retention could trim it.
    for (let i = 0; i < 5; i++) w.append("info", "Ctx", `ppm-${i}`);

    const names = readdirSync(d).filter((n) => n.endsWith(".txt"));
    // Rotated files exist and the naming is the advertised medianexus.N.txt shape.
    expect(names).toContain("medianexus.txt");
    expect(names).toContain("medianexus.1.txt");

    // The current file is fresh (does NOT hold the first line) while the oldest message landed
    // in rotated history — proving a real shift happened, not just append-in-place.
    expect(readFileSync(join(d, "medianexus.txt"), "utf8")).not.toContain("ppm-0");
    expect(readFileSync(join(d, "medianexus.1.txt"), "utf8")).toContain("ppm-0");
  });

  it("lists physical files newest-first with correct size and datetime", () => {
    const d = mkdtempSync(join(tmpdir(), "mn-list-"));
    const w = new LogFileWriter(d);
    w.append("info", "A", "listable content");
    const listed = w.list();
    expect(listed.length).toBeGreaterThan(0);
    const first = listed[0];
    expect(first.name).toBe("medianexus.txt");
    expect(first.sizeBytes).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(first.createdAt))).toBe(false);
  });

  it("rejects path traversal and non-log names on download (400, not 404), 404 for a missing real name", () => {
    const d = mkdtempSync(join(tmpdir(), "mn-trav-"));
    const w = new LogFileWriter(d);
    w.append("info", "A", "x");

    for (const bad of ["../../../etc/passwd", "/etc/passwd", "medianexus-../../x.txt", "medianexus-backup-1.sqlite3"]) {
      expect(() => w.openDownload(bad)).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    }
    // A well-formed log name that isn't on disk is a 404, not a validation error; the current
    // file (which exists) downloads fine.
    expect(() => w.openDownload("medianexus.txt")).not.toThrow();
    // ".1" isn't present yet (no rotation happened) but IS a recognized log-file name -> 404.
    expect(() => w.openDownload("medianexus.1.txt")).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
    // No stray files surfaced from the rejected attempts.
    expect(readdirSync(d).some((n) => n.includes("passwd"))).toBe(false);
  });

  it("retention keeps the N newest and deletes older rotated files (not just renames)", () => {
    const d = mkdtempSync(join(tmpdir(), "mn-keep-"));
    const w = new LogFileWriter(d, 60, 2); // keep current + 2 rotated
    // Enough appends to force several rotations past the keep count.
    for (let i = 0; i < 60; i++) w.append("info", "Ctx", `keep-${i}`);

    const names = readdirSync(d).filter((n) => n.endsWith(".txt"));
    expect(names.length).toBeLessThanOrEqual(3); // current + .1 + .2
    expect(names).not.toContain("medianexus.3.txt");
  });
});
