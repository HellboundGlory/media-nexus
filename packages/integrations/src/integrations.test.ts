// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { ProviderRegistry } from "./registry";
import { MemoryIndexerProvider, MemoryDownloadClientProvider } from "./memory";
import { newznabSettingsSchema, qbittorrentSettingsSchema, indexerProxySchema } from "./schemas";

describe("ProviderRegistry", () => {
  const reg = new ProviderRegistry();
  reg.register("indexer", new MemoryIndexerProvider());
  reg.register("downloadClient", new MemoryDownloadClientProvider());

  it("stores and retrieves providers by kind + key", () => {
    expect(reg.keys("indexer")).toEqual(["memory"]);
    expect(reg.require("downloadClient", "memory").kind).toBe("torrent");
    expect(() => reg.require("indexer", "nope")).toThrow(/no indexer provider/);
  });
});

describe("MemoryIndexerProvider", () => {
  it("searches preset releases and filters by query", async () => {
    const p = new MemoryIndexerProvider();
    const all = await p.search({ mediaType: "movie" });
    expect(all.length).toBeGreaterThan(0);
    const none = await p.search({ mediaType: "movie", query: "zzz-no-such-title" });
    expect(none.length).toBe(0);
  });
});

describe("MemoryDownloadClientProvider", () => {
  it("adds releases to its queue and completes them", async () => {
    const p = new MemoryDownloadClientProvider();
    const indexer = new MemoryIndexerProvider();
    const [r] = await indexer.search({ mediaType: "movie" });
    const { downloadId } = await p.addRelease({ release: r, category: "movie" });
    expect(downloadId).toBeTruthy();
    expect((await p.getQueue()).length).toBe(1);
    p.completeDownload(downloadId, 100);
    expect((await p.getQueue())[0].status).toBe("completed");
  });
});

describe("provider config schemas", () => {
  it("validates newznab + qbittorrent + proxy settings", () => {
    expect(newznabSettingsSchema.safeParse({ baseUrl: "https://x", apiKey: "k" }).success).toBe(true);
    expect(newznabSettingsSchema.safeParse({ baseUrl: "not-a-url", apiKey: "" }).success).toBe(false);
    expect(qbittorrentSettingsSchema.safeParse({ host: "http://qb:8080" }).success).toBe(true);
    expect(indexerProxySchema.safeParse({ enabled: true, type: "socks5", host: "h", port: 1080 }).success).toBe(true);
  });
});
