// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { runHealthChecks, overallLevel, type HealthContext, type HealthCheckResult } from "./health";

function baseContext(over: Partial<HealthContext> = {}): HealthContext {
  return {
    indexers: [{ enabled: true, status: "ok" }],
    downloadClients: [{ enabled: true, kind: "torrent", reachable: true }],
    rootFolders: [{ name: "Movies", accessible: true, freeBytes: 10_000_000_000 }],
    downloadsPathConfigured: true,
    downloadsPathAccessible: true,
    minimumFreeSpaceMb: 100,
    preferredProtocol: "any",
    tmdbApiKeyConfigured: true,
    recentFailedJobKeys: [],
    recentContentNotFoundCount: 0,
    ...over,
  };
}

function find(results: HealthCheckResult[], key: string): HealthCheckResult {
  const r = results.find((x) => x.key === key);
  if (!r) throw new Error(`no result for ${key}`);
  return r;
}

describe("runHealthChecks — all healthy", () => {
  it("returns 10 ok results for a fully healthy context", () => {
    const results = runHealthChecks(baseContext());
    expect(results).toHaveLength(10);
    expect(results.every((r) => r.level === "ok")).toBe(true);
    expect(overallLevel(results)).toBe("ok");
  });
});

describe("indexers.none", () => {
  it("errors when no indexers are enabled", () => {
    const r = find(runHealthChecks(baseContext({ indexers: [{ enabled: false, status: "disabled" }] })), "indexers.none");
    expect(r.level).toBe("error");
  });
});

describe("indexers.allFailing", () => {
  it("errors when every enabled indexer is failing", () => {
    const r = find(runHealthChecks(baseContext({ indexers: [{ enabled: true, status: "error" }] })), "indexers.allFailing");
    expect(r.level).toBe("error");
  });
  it("warns when only some enabled indexers are failing", () => {
    const r = find(
      runHealthChecks(baseContext({ indexers: [{ enabled: true, status: "error" }, { enabled: true, status: "ok" }] })),
      "indexers.allFailing",
    );
    expect(r.level).toBe("warning");
  });
  it("is ok when there are no enabled indexers to check (indexers.none already covers that case)", () => {
    const r = find(runHealthChecks(baseContext({ indexers: [] })), "indexers.allFailing");
    expect(r.level).toBe("ok");
  });
});

describe("downloadClients.unreachable", () => {
  it("warns when no download clients are configured", () => {
    const r = find(runHealthChecks(baseContext({ downloadClients: [] })), "downloadClients.unreachable");
    expect(r.level).toBe("warning");
  });
  it("errors when every enabled client is unreachable", () => {
    const r = find(
      runHealthChecks(baseContext({ downloadClients: [{ enabled: true, kind: "torrent", reachable: false }] })),
      "downloadClients.unreachable",
    );
    expect(r.level).toBe("error");
  });
  it("warns when only some enabled clients are unreachable", () => {
    const r = find(
      runHealthChecks(baseContext({
        downloadClients: [
          { enabled: true, kind: "torrent", reachable: false },
          { enabled: true, kind: "usenet", reachable: true },
        ],
      })),
      "downloadClients.unreachable",
    );
    expect(r.level).toBe("warning");
  });
});

describe("rootFolders.missingOrUnwritable", () => {
  it("warns when no root folders are configured", () => {
    const r = find(runHealthChecks(baseContext({ rootFolders: [] })), "rootFolders.missingOrUnwritable");
    expect(r.level).toBe("warning");
  });
  it("errors when a configured root folder is inaccessible", () => {
    const r = find(
      runHealthChecks(baseContext({ rootFolders: [{ name: "Movies", accessible: false, freeBytes: null }] })),
      "rootFolders.missingOrUnwritable",
    );
    expect(r.level).toBe("error");
  });
});

describe("downloadsPath.missing", () => {
  it("warns when unconfigured", () => {
    const r = find(runHealthChecks(baseContext({ downloadsPathConfigured: false })), "downloadsPath.missing");
    expect(r.level).toBe("warning");
  });
  it("errors when configured but inaccessible", () => {
    const r = find(runHealthChecks(baseContext({ downloadsPathAccessible: false })), "downloadsPath.missing");
    expect(r.level).toBe("error");
  });
});

describe("diskSpace.low", () => {
  it("warns when a root folder is below the configured margin", () => {
    const r = find(
      runHealthChecks(baseContext({ rootFolders: [{ name: "Movies", accessible: true, freeBytes: 1_000 }], minimumFreeSpaceMb: 100 })),
      "diskSpace.low",
    );
    expect(r.level).toBe("warning");
  });
  it("is ok when free space is unknown (null)", () => {
    const r = find(
      runHealthChecks(baseContext({ rootFolders: [{ name: "Movies", accessible: true, freeBytes: null }] })),
      "diskSpace.low",
    );
    expect(r.level).toBe("ok");
  });
});

describe("protocol.noClientForPreferred", () => {
  it("is ok when preference is 'any'", () => {
    const r = find(runHealthChecks(baseContext({ preferredProtocol: "any", downloadClients: [] })), "protocol.noClientForPreferred");
    expect(r.level).toBe("ok");
  });
  it("errors when no enabled client matches the preferred protocol", () => {
    const r = find(
      runHealthChecks(baseContext({ preferredProtocol: "usenet", downloadClients: [{ enabled: true, kind: "torrent", reachable: true }] })),
      "protocol.noClientForPreferred",
    );
    expect(r.level).toBe("error");
  });
  it("is ok when an enabled client matches", () => {
    const r = find(
      runHealthChecks(baseContext({ preferredProtocol: "torrent", downloadClients: [{ enabled: true, kind: "torrent", reachable: true }] })),
      "protocol.noClientForPreferred",
    );
    expect(r.level).toBe("ok");
  });
});

describe("metadata.tmdbKeyMissing", () => {
  it("warns when unset", () => {
    const r = find(runHealthChecks(baseContext({ tmdbApiKeyConfigured: false })), "metadata.tmdbKeyMissing");
    expect(r.level).toBe("warning");
  });
});

describe("jobs.recentFailures", () => {
  it("warns and dedupes job keys when failures occurred in the last hour", () => {
    const r = find(runHealthChecks(baseContext({ recentFailedJobKeys: ["media.rssSync", "media.rssSync"] })), "jobs.recentFailures");
    expect(r.level).toBe("warning");
    expect(r.message).toContain("media.rssSync");
    expect(r.message.match(/media\.rssSync/g)).toHaveLength(1);
  });
});

describe("acquisition.contentNotFound", () => {
  it("warns when recent content-not-found failures exist", () => {
    const r = find(runHealthChecks(baseContext({ recentContentNotFoundCount: 2 })), "acquisition.contentNotFound");
    expect(r.level).toBe("warning");
    expect(r.message).toContain("2 completed download(s)");
  });
});

describe("overallLevel", () => {
  it("returns the worst level across results", () => {
    const results: HealthCheckResult[] = [
      { key: "a", ok: true, level: "ok", message: "" },
      { key: "b", ok: false, level: "warning", message: "" },
      { key: "c", ok: false, level: "error", message: "" },
    ];
    expect(overallLevel(results)).toBe("error");
    expect(overallLevel(results.filter((r) => r.key !== "c"))).toBe("warning");
    expect(overallLevel([])).toBe("ok");
  });
});
