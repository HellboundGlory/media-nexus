// SPDX-License-Identifier: MIT
/**
 * Roadmap P3, gap report C8 (update-check sub-item) — system.updateCheck job + GET /api/v1/system/update-check.
 *
 * Covers:
 *  - compareVersions: the semver comparison at the heart of updateAvailable (current < latest,
 *    current == latest, current > latest — a dev build ahead of the last tag must never crash),
 *    plus the leading-"v" tag normalization.
 *  - UpdateCheckService: success path populates the in-memory cache; the network-failure path
 *    (fetch rejects / non-200 / unparseable body) must complete without throwing, keep the cache
 *    at its previous value (or null), and log a warn — never an error — so an internet-less LAN
 *    install never has this job fail loudly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Logger as NestLogger } from "@nestjs/common";
import { UpdateCheckService, compareVersions } from "../src/system/update-check.service";
import type { SystemStatusService } from "../src/system/system-status.service";

const stubStatus = (version = "1.2.0") =>
  ({ version }) as unknown as SystemStatusService;

function failingFetch(msg: string): typeof fetch {
  return (async () => {
    throw new Error(msg);
  }) as unknown as typeof fetch;
}

/** Mock of the GitHub tags endpoint: an array of { name } entries (NOT sorted by version). */
function tagsFetch(tagNames: string[]): typeof fetch {
  return (async () => ({ ok: true, json: async () => tagNames.map((name) => ({ name, commit: {} })) })) as unknown as typeof fetch;
}

function okFetch(body: unknown): typeof fetch {
  return (async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch;
}

function httpFetch(status: number): typeof fetch {
  return (async () => ({ ok: status >= 200 && status < 300, status })) as unknown as typeof fetch;
}

describe("compareVersions (semver comparison)", () => {
  it("reports current < latest as an update being available", () => {
    expect(compareVersions("1.2.0", "1.2.1")).toBeLessThan(0);
    expect(compareVersions("1.2.0", "1.3.0")).toBeLessThan(0);
    expect(compareVersions("1.9.0", "1.10.0")).toBeLessThan(0); // numeric, not lexicographic
    expect(compareVersions("2.0.0", "10.0.0")).toBeLessThan(0);
  });

  it("reports current == latest as no update", () => {
    expect(compareVersions("1.2.0", "1.2.0")).toBe(0);
    expect(compareVersions("1.2.0", "v1.2.0")).toBe(0); // leading "v" on the tag is normalized
  });

  it("reports current > latest (a dev build ahead of the last tag) as no update, without crashing", () => {
    expect(compareVersions("1.2.1", "1.2.0")).toBeGreaterThan(0);
    expect(compareVersions("1.3.0", "1.2.0")).toBeGreaterThan(0);
    expect(compareVersions("10.0.0", "2.0.0")).toBeGreaterThan(0);
  });
});

describe("UpdateCheckService", () => {
  // `vi.spyOn` on an already-mocked method returns the SAME spy (accumulating call history across
  // tests), which would leak prior warn/error calls into later assertions — restore between tests
  // so each `const warnSpy = vi.spyOn(...)` starts from a clean instance.
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("reports 'not checked yet' until a successful run, then surfaces the cached result", async () => {
    const svc = new UpdateCheckService(stubStatus("1.2.0"));
    // Cold cache: no network call has happened, so the endpoint shape says so.
    const cold = svc.get();
    expect(cold.checked).toBe(false);
    expect(cold.currentVersion).toBe("1.2.0");
    expect(cold.updateAvailable).toBe(false);

    svc.fetchImpl = tagsFetch(["v1.2.0", "v1.3.0"]); // unsorted; should pick the max
    const result = await svc.run();
    expect(result).not.toBeNull();

    const warm = svc.get();
    expect(warm.checked).toBe(true);
    expect(warm.currentVersion).toBe("1.2.0");
    expect(warm.latestVersion).toBe("1.3.0");
    expect(warm.updateAvailable).toBe(true);
    expect(warm.releaseUrl).toContain("v1.3.0");
    expect(typeof warm.checkedAt).toBe("string");
  });

  it("is a no-op check, not an updater: the endpoint never performs a network call by itself", async () => {
    const svc = new UpdateCheckService(stubStatus("1.2.0"));
    svc.fetchImpl = failingFetch("should never be called");
    // get() only reads the cache — no fetch happens.
    const s = svc.get();
    expect(s.checked).toBe(false);
  });

  it("tolerates a network failure: completes without throwing, keeps the cold cache, logs a warn not an error", async () => {
    const warnSpy = vi.spyOn(NestLogger.prototype, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(NestLogger.prototype, "error").mockImplementation(() => {});
    const svc = new UpdateCheckService(stubStatus("1.2.0"));
    svc.fetchImpl = failingFetch("fetch failed: ECONNREFUSED (offline LAN)");

    // The job must resolve (never throw) on a network failure.
    await expect(svc.run()).resolves.toBeNull();
    expect(svc.get().checked).toBe(false); // cache stays cold/null
    expect(warnSpy).toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("keeps a previously-successful result stale (rather than clearing it) when a later check fails", async () => {
    const warnSpy = vi.spyOn(NestLogger.prototype, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(NestLogger.prototype, "error").mockImplementation(() => {});
    const svc = new UpdateCheckService(stubStatus("1.2.0"));
    svc.fetchImpl = tagsFetch(["v1.3.0"]);
    await svc.run();

    // A transient GitHub outage / rate-limit on the next run should leave the last result intact.
    svc.fetchImpl = failingFetch("GitHub is rate-limited (403)");
    const result = await svc.run();
    expect(result?.latestVersion).toBe("1.3.0");
    const still = svc.get();
    expect(still.checked).toBe(true);
    expect(still.latestVersion).toBe("1.3.0");
    expect(warnSpy).toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("tolerates a non-200 response and a non-array body the same way (warn, keep stale, never throw)", async () => {
    const warnSpy = vi.spyOn(NestLogger.prototype, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(NestLogger.prototype, "error").mockImplementation(() => {});
    const svc = new UpdateCheckService(stubStatus("1.2.0"));

    svc.fetchImpl = httpFetch(403); // rate-limited
    await expect(svc.run()).resolves.toBeNull();
    expect(svc.get().checked).toBe(false);

    svc.fetchImpl = okFetch({}); // 200 but a non-array body (not the tags list we expect)
    await expect(svc.run()).resolves.toBeNull();
    expect(svc.get().checked).toBe(false);

    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("treats an EMPTY tags array as a successful 'nothing to report yet' — warm, no-latest, no warn", async () => {
    const warnSpy = vi.spyOn(NestLogger.prototype, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(NestLogger.prototype, "error").mockImplementation(() => {});
    const svc = new UpdateCheckService(stubStatus("1.2.0"));

    // This is the repo's actual current live state (old tags deleted, no new ones pushed yet).
    svc.fetchImpl = tagsFetch([]);
    const result = await svc.run();
    expect(result).not.toBeNull(); // a completed check, not a failure

    const warm = svc.get();
    expect(warm.checked).toBe(true);
    expect(warm.latestVersion).toBeNull();
    expect(warm.updateAvailable).toBe(false);
    expect(warm.releaseUrl).toBeNull();
    expect(typeof warm.checkedAt).toBe("string");
    expect(warnSpy).not.toHaveBeenCalled(); // not a failure -> not a warn
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("ignores non-version tags and picks the numeric max even when the list is out of order", async () => {
    const svc = new UpdateCheckService(stubStatus("1.2.0"));
    // A future non-release tag (branch/design/anime etc.) must not be miscompared or crash.
    svc.fetchImpl = tagsFetch(["v1.2.0", "dev-2026", "v1.10.0", "0.9.0", "v1.3.0"]);
    await svc.run();
    const warm = svc.get();
    expect(warm.latestVersion).toBe("1.10.0"); // numeric max, ignoring "dev-2026"/"0.9.0"-type noise
    expect(warm.updateAvailable).toBe(true);
  });

  it("reports no update when current version equals-or-exceeds the latest tag", async () => {
    const svc = new UpdateCheckService(stubStatus("1.2.0"));
    svc.fetchImpl = tagsFetch(["v1.2.0"]);
    await svc.run();
    expect(svc.get().updateAvailable).toBe(false);

    // A dev build ahead of the latest tag (e.g. current 1.2.1) must report no update, not crash.
    const dev = new UpdateCheckService(stubStatus("1.2.1"));
    dev.fetchImpl = tagsFetch(["v1.2.0"]);
    await dev.run();
    expect(dev.get().updateAvailable).toBe(false);
  });
});
