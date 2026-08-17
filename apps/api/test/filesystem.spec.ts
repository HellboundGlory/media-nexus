// SPDX-License-Identifier: MIT
/**
 * UNI-012 — GET /system/filesystem host filesystem browser.
 *
 * Two parts:
 *  - unit: FilesystemService against a real mkdtemp tree — listing, sorted directories, parent
 *    at depth, the nested missing-path fallback, files excluded, and default `/` root.
 *  - integration (supertest over the full AppModule): AdminGuard enforcement — an
 *    unauthenticated request is rejected (401 via the global key guard), an authenticated admin
 *    request gets a 200.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/configure";
import { FilesystemService } from "../src/system/filesystem.service";

const root = mkdtempSync(join(tmpdir(), "mn-fs-"));

describe("FilesystemService (unit)", () => {
  // a/ b/ c/ (with deeper/)  and a plain file (should be excluded)
  const base = mkdtempSync(join(tmpdir(), "mn-fs-tree-"));
  beforeAll(() => {
    mkdirSync(join(base, "a"));
    mkdirSync(join(base, "b"));
    mkdirSync(join(base, "c"));
    mkdirSync(join(base, "c", "deeper"));
    writeFileSync(join(base, "not-a-dir.txt"), "x");
  });

  it("lists subdirectories of the requested path, sorted alphabetically, files excluded", () => {
    const svc = new FilesystemService();
    const listing = svc.list(base);
    expect(listing.path).toBe(base);
    expect(listing.directories.map((d) => d.name)).toEqual(["a", "b", "c"]);
    expect(listing.directories.every((d) => d.path.startsWith(base + "/"))).toBe(true);
  });

  it("computes the parent at a few depths (null only at the real root)", () => {
    const svc = new FilesystemService();
    expect(svc.list(base + "/c/deeper").parent).toBe(base + "/c");
    expect(svc.list(base + "/c").parent).toBe(base);
    expect(svc.list("/").parent).toBeNull();
  });

  it("falls back to the nearest existing ancestor for a non-existent path in the tree", () => {
    const svc = new FilesystemService();
    const listing = svc.list(base + "/a/does-not-exist");
    // Walked up from does-not-exist to the nearest existing ancestor: a (which we created).
    expect(listing.path).toBe(base + "/a");
    expect(listing.parent).toBe(base);
    expect(listing.directories).toEqual([]); // a has no subdirectories
  });

  it("falls all the way back to / for a path with no existing ancestor", () => {
    const svc = new FilesystemService();
    const listing = svc.list("/nonexistent-parent-xyz/deeper/foo");
    expect(listing.path).toBe("/");
    expect(listing.parent).toBeNull();
    // / always contains tmp (where our temp tree lives)
    expect(listing.directories.map((d) => d.name)).toContain("tmp");
  });

  it("defaults to the filesystem root when no path is given", () => {
    const svc = new FilesystemService();
    const listing = svc.list();
    expect(listing.path).toBe("/");
    expect(listing.parent).toBeNull();
  });

  it("follows symlinked directories into the listing, and silently skips dangling ones", () => {
    // Regression: a plain Dirent's isDirectory() does NOT resolve symlinks, so a symlinked
    // directory (a common NAS-mount pattern for root folders) was being silently dropped.
    const sym = mkdtempSync(join(tmpdir(), "mn-fs-sym-"));
    mkdirSync(join(sym, "real"));
    mkdirSync(join(sym, "container"));
    symlinkSync(join(sym, "real"), join(sym, "container", "link"));
    symlinkSync(join(sym, "does-not-exist"), join(sym, "container", "dangling"));

    const svc = new FilesystemService();
    const listing = svc.list(join(sym, "container"));
    expect(listing.directories.map((d) => d.name)).toContain("link"); // real target is a dir
    expect(listing.directories.map((d) => d.name)).not.toContain("dangling"); // broken link skipped
    // A plain file in the same container is still excluded (symlink handling changes nothing
    // for real files).
    writeFileSync(join(sym, "container", "file.txt"), "x");
    expect(svc.list(join(sym, "container")).directories.map((d) => d.name)).not.toContain("file.txt");
  });
});

describe("GET /system/filesystem (AdminGuard)", () => {
  let app: INestApplication;
  let http: any;
  const API_KEY = "test-bootstrap-key-123";

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "mn-fs-app-"));
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = join(dir, "test.db");
    process.env.AUTO_MIGRATE = "true";
    process.env.MEDIA_NEXUS_SECRET = "test-secret-only";
    process.env.MEDIA_NEXUS_BOOTSTRAP_KEY = API_KEY;
    process.env.JOB_CONCURRENCY = "1";
    process.env.LOG_LEVEL = "warn";
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    http = app.getHttpServer();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("rejects an unauthenticated request (401) — AdminGuard-protected like backups/log-files", async () => {
    expect((await request(http).get("/api/v1/system/filesystem")).status).toBe(401);
  });

  it("lists the real filesystem root for an authenticated admin request", async () => {
    const res = await request(http).get("/api/v1/system/filesystem").set("X-Api-Key", API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.path).toBe("/");
    expect(res.body.parent).toBeNull();
    expect(Array.isArray(res.body.directories)).toBe(true);
    // The temp tree lives under /tmp, so it must be visible from the root.
    expect(res.body.directories.map((d: { name: string }) => d.name)).toContain("tmp");
  });

  it("lists a requested tree path for an authenticated admin request", async () => {
    const res = await request(http).get(`/api/v1/system/filesystem?path=${encodeURIComponent(root)}`).set("X-Api-Key", API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.path).toBe(root);
  });
});
