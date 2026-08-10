// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { buildSonarrV3Surface } from "./sonarr";
import type { NativeStatusSource } from "./sonarr";

describe("compatibility: sonarr v3 surface", () => {
  const source: NativeStatusSource = {
    appVersion: () => "0.1.0",
    appName: () => "MediaNexus",
    started: () => "2026-01-01T00:00:00Z",
    databaseVersion: () => "1",
  };
  const surface = buildSonarrV3Surface(source);

  it("translates system/status into the sonarr v3 wire shape", async () => {
    const hit = surface.match("GET", "/api/sonarr/v3/system/status");
    expect(hit).not.toBeNull();
    const res = await hit!.route.handler(hit!.ctx);
    expect(res.status).toBe(200);
    const body = res.body as any;
    expect(body.appName).toBe("MediaNexus");
    expect(body.authentication).toBe("ApiKey");
    expect(body.version).toBe("0.1.0");
  });

  it("explicitly 501s not-yet-adapted endpoints instead of pretending", async () => {
    const hit = surface.match("GET", "/api/sonarr/v3/series");
    expect(hit).not.toBeNull();
    const res = await hit!.route.handler(hit!.ctx);
    expect(res.status).toBe(501);
  });

  it("does not match unknown routes", () => {
    expect(surface.match("GET", "/api/sonarr/v3/not-a-route")).toBeNull();
  });
});
