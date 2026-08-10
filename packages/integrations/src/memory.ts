// SPDX-License-Identifier: MIT
/**
 * In-memory demo providers — prove the acquisition/search plumbing end-to-end
 * without a live indexer or download client. Replaced by real HTTP providers in M1.
 */
import type {
  IndexerContract, DownloadClientContract, HealthResult,
  ClientQueueItem, AddDownloadInput, SearchParams,
} from "./contracts";
import type { Release } from "@medianexus/domain";
import { z } from "zod";

export const memoryIndexerSettingsSchema = z.object({
  title: z.string().default("Demo"),
});
export type MemoryIndexerSettings = z.infer<typeof memoryIndexerSettingsSchema>;

export class MemoryIndexerProvider implements IndexerContract {
  readonly key = "memory";
  readonly protocol = "torrent" as const;
  private readonly releases: Release[];

  constructor(releases: Release[] = defaultReleases()) {
    this.releases = releases;
  }

  async search(params: SearchParams): Promise<Release[]> {
    const limit = params.limit ?? 20;
    const q = params.query?.toLowerCase() ?? "";
    return this.releases.filter((r) => !q || r.title.toLowerCase().includes(q)).slice(0, limit);
  }

  async healthcheck(): Promise<HealthResult> {
    return { ok: true, latencyMs: 1, message: "in-memory demo indexer" };
  }
}

export const memoryClientSettingsSchema = z.object({
  fakeLatencyMs: z.number().int().min(0).default(0),
});
export type MemoryClientSettings = z.infer<typeof memoryClientSettingsSchema>;

export class MemoryDownloadClientProvider implements DownloadClientContract {
  readonly key = "memory";
  readonly kind = "torrent" as const;
  private queue = new Map<string, ClientQueueItem>();

  async addRelease(input: AddDownloadInput): Promise<{ downloadId: string }> {
    const downloadId = `dl_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const item: ClientQueueItem = {
      downloadId,
      title: input.release.title,
      status: "downloading",
      progress: 5,
      size: input.release.size,
    };
    this.queue.set(downloadId, item);
    return { downloadId };
  }

  async getQueue(): Promise<ClientQueueItem[]> {
    return [...this.queue.values()].map((q) => ({ ...q }));
  }

  /** Test helper: simulate completion so the download-monitor job can import. */
  completeDownload(downloadId: string, progress = 100): void {
    const item = this.queue.get(downloadId);
    if (item) {
      item.progress = progress;
      item.status = "completed";
    }
  }

  async remove(downloadId: string): Promise<void> {
    this.queue.delete(downloadId);
  }

  async healthcheck(): Promise<HealthResult> {
    return { ok: true, latencyMs: 1, message: "in-memory demo download client" };
  }
}

export function defaultReleases(): Release[] {
  return [
    {
      id: "mem_rel_1",
      indexerId: "idx_memory",
      indexerName: "Demo Indexer",
      title: "The Matrix (1999) [BluRay-1080p]",
      protocol: "torrent",
      categories: [2000],
      size: 4_200_000_000,
      ageHours: 24,
      seeders: 120,
      leechers: 3,
      peers: 123,
      magnetUrl: "magnet:?xt=urn:btih:DEMO1&dn=matrix",
      quality: { source: "bluray", resolution: "1080p", edition: "" },
      isFreeleech: false,
      isProper: false,
      isRepack: false,
    },
    {
      id: "mem_rel_2",
      indexerId: "idx_memory",
      indexerName: "Demo Indexer",
      title: "The Matrix (1999) [WEB-720p]",
      protocol: "torrent",
      categories: [2000],
      size: 1_800_000_000,
      ageHours: 12,
      seeders: 240,
      leechers: 5,
      peers: 245,
      magnetUrl: "magnet:?xt=urn:btih:DEMO2&dn=matrix720",
      quality: { source: "web", resolution: "720p", edition: "" },
      isFreeleech: true,
      isProper: false,
      isRepack: true,
    },
  ];
}
