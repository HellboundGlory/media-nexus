// SPDX-License-Identifier: MIT
/**
 * SON-025 Phases 4 & 5 — custom-format import/export (native /api/v1) and the Sonarr/Radarr
 * compat /customformat REST surface. Reuses the same domain mapper for both, so behavior
 * (incl. unsupported-implementation reporting) is identical through either path.
 */
import { describe, beforeAll, afterAll, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/configure";

const API_KEY = "test-bootstrap-key-123";
let app: INestApplication;
let http: any;
const auth = (r: any) => r.set("X-Api-Key", API_KEY);

// The real "720p Quality Tier 1" shape — upstream values: resolution = literal pixel height
// (720), source = QualitySource enum (9=Bluray, 8=WEBRip), release group = regex patterns.
const DON_RG = "(?<=^|[\\s.-])DON\\b";
const REBORN_RG = "(?<=^|[\\s.-])REBORN\\b";
const TIER1 = {
  name: "720p Quality Tier 1",
  includeCustomFormatWhenRenaming: false,
  specifications: [
    { implementation: "ResolutionSpecification", required: true, negate: false, fields: { value: 720 } },
    { implementation: "ReleaseTitleSpecification", required: true, negate: true, fields: { value: "Remux" } },
    { implementation: "SourceSpecification", required: false, negate: false, fields: { value: 9 } },
    { implementation: "SourceSpecification", required: false, negate: false, fields: { value: 8 } },
    { implementation: "ReleaseGroupSpecification", required: false, negate: false, fields: { value: DON_RG } },
    { implementation: "ReleaseGroupSpecification", required: false, negate: false, fields: { value: REBORN_RG } },
  ],
};

const AAC = {
  name: "AAC",
  includeCustomFormatWhenRenaming: false,
  specifications: [
    { implementation: "ReleaseTitleSpecification", required: true, negate: false, fields: { value: "\\bAAC(\\b|\\d)" } },
    { implementation: "ReleaseTitleSpecification", required: true, negate: false, fields: { value: "1080p" } },
  ],
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "mn-cfio-"));
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

afterAll(async () => { await app?.close(); });

describe("native custom-format import/export (UNI-025)", () => {
  it("imports the real '720p Quality Tier 1' body and lists it", async () => {
    const res = await auth(request(http).post("/api/v1/custom-formats/import")).send(TIER1);
    expect(res.status).toBe(201);
    expect(res.body.imported).toBe(6);
    expect(res.body.skipped).toEqual([]);
    expect(res.body.format.specs).toHaveLength(6);

    const list = await auth(request(http).get("/api/v1/custom-formats"));
    expect(list.status).toBe(200);
    expect(list.body.some((f: any) => f.name === "720p Quality Tier 1")).toBe(true);
  });

  it("exports a format back into the upstream shape (round-trip)", async () => {
    const list = await auth(request(http).get("/api/v1/custom-formats"));
    const fmt = list.body.find((f: any) => f.name === "720p Quality Tier 1");
    const ex = await auth(request(http).get(`/api/v1/custom-formats/${fmt.id}/export`));
    expect(ex.status).toBe(200);
    expect(ex.body.name).toBe("720p Quality Tier 1");
    expect(ex.body.specifications).toContainEqual(expect.objectContaining({ implementation: "ResolutionSpecification" }));
  });

  it("reports unsupported conditions and still imports the supported ones", async () => {
    const res = await auth(request(http).post("/api/v1/custom-formats/import")).send({
      name: "Mixed with IndexerFlag",
      specifications: [
        { implementation: "ReleaseTitleSpecification", fields: { value: "x265" } },
        { implementation: "IndexerFlagSpecification", fields: { value: 1 } },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.imported).toBe(1);
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0].implementation).toBe("IndexerFlagSpecification");
  });

  it("rejects a body with zero supported conditions (no silent no-op)", async () => {
    const res = await auth(request(http).post("/api/v1/custom-formats/import")).send({
      name: "All unsupported",
      specifications: [{ implementation: "IndexerFlagSpecification", fields: { value: 1 } }],
    });
    expect(res.status).toBe(400);
  });
});

describe("compat /customformat (UNI-026)", () => {
  it("Radarr: create one of the real bodies via /api/radarr/v3/customformat and it lands natively", async () => {
    const created = await auth(request(http).post("/api/radarr/v3/customformat")).send(AAC);
    expect(created.status).toBe(201);
    expect(created.body.name).toBe("AAC");

    const listed = await auth(request(http).get("/api/radarr/v3/customformat"));
    expect(listed.status).toBe(200);
    expect(listed.body.some((f: any) => f.name === "AAC")).toBe(true);

    // The compat-created format shows up in the native list (shared store).
    const native = await auth(request(http).get("/api/v1/custom-formats"));
    expect(native.body.some((f: any) => f.name === "AAC")).toBe(true);

    // Update through the compat surface.
    const id = created.body.id;
    const updated = await auth(request(http).put(`/api/radarr/v3/customformat/${id}`)).send({
      name: "AAC Renamed", specifications: [{ implementation: "ReleaseTitleSpecification", fields: { value: "eac3" } }],
    });
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe("AAC Renamed");

    const schema = await auth(request(http).get("/api/radarr/v3/customformat/schema"));
    expect(schema.status).toBe(200);
    expect(schema.body.some((s: any) => s.implementation === "ReleaseGroupSpecification")).toBe(true);

    const del = await auth(request(http).delete(`/api/radarr/v3/customformat/${id}`));
    expect(del.status).toBe(200);
  });

  it("Sonarr: create/list via /api/sonarr/v3/customformat", async () => {
    const created = await auth(request(http).post("/api/sonarr/v3/customformat")).send(AAC);
    expect(created.status).toBe(201);
    const listed = await auth(request(http).get("/api/sonarr/v3/customformat"));
    expect(listed.status).toBe(200);
    expect(listed.body.some((f: any) => f.name === "AAC")).toBe(true);
  });

  it("compat create behaves identically to native on an unsupported implementation (skipped, not fatal)", async () => {
    const res = await auth(request(http).post("/api/radarr/v3/customformat")).send({
      name: "Compat mixed",
      specifications: [
        { implementation: "ReleaseTitleSpecification", fields: { value: "imax" } },
        { implementation: "EditionSpecification", fields: { value: "4K77" } },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.specifications).toHaveLength(1); // only the supported condition
    expect(res.body.specifications[0].implementation).toBe("ReleaseTitleSpecification");
    // The unsupported condition is reported, not silently dropped.
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0].implementation).toBe("EditionSpecification");
  });
});
