// SPDX-License-Identifier: MIT
/**
 * NZBGet download client provider — JSON-RPC 2.0 over `POST /jsonrpc` (WebGet API).
 * getQueue() merges `listgroups` (active queue) with `history` (completed/failed) so the
 * download-monitor can import finished jobs. Sits on the shared DownloadClientBase transport.
 */
import type { ClientQueueItem, AddDownloadInput, HealthResult } from "./contracts";
import type { NzbgetSettings } from "./schemas";
import { DownloadClientBase } from "./base";

interface NzbGroup {
  NZBID?: number;
  NZBName?: string;
  Status?: string;
  FileSizeLo?: number;
  FileSizeHi?: number;
  RemainingSizeLo?: number;
  RemainingSizeHi?: number;
  Category?: string;
}

interface NzbHistoryItem {
  NZBID?: number;
  NZBName?: string;
  Status?: string;
  Category?: string;
}

interface RpcError {
  message?: string;
}

export class NzbgetProvider extends DownloadClientBase<NzbgetSettings> {
  readonly key = "nzbget";
  readonly kind = "usenet" as const;

  /** Issue a NZBGet JSON-RPC call and return the `result`, throwing on an error envelope. */
  private async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const res = await this.request("/jsonrpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
    });
    if (!res.ok) throw new Error(`NZBGet ${method} HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: RpcError };
    if (body.error) throw new Error(`NZBGet ${method} failed: ${body.error.message ?? "unknown error"}`);
    return body.result as T;
  }

  async addRelease(input: AddDownloadInput): Promise<{ downloadId: string }> {
    const release = input.release;
    const nzbUrl = release.downloadUrl;
    if (!nzbUrl) throw new Error("NZBGet requires a usenet nzb URL on the release");
    // append(NZBName, NZBContent, Category, Priority, AddToTop, AddPaused, DupeKey, DupeMode,
    //         DupeScore, AddUrl) — AddUrl=true makes NZBContent a URL for NZBGet to fetch.
    const nzoId = await this.call<number>("append", [
      "", nzbUrl, input.category ?? this.settings.category ?? "movies",
      this.settings.priority ?? 0, false, false, "", 0, 0, true,
    ]);
    if (nzoId === undefined || nzoId === null) throw new Error("NZBGet append returned no id");
    return { downloadId: String(nzoId) };
  }

  async getQueue(): Promise<ClientQueueItem[]> {
    const out: ClientQueueItem[] = [];

    const groups = await this.call<NzbGroup[]>("listgroups");
    for (const g of groups ?? []) {
      const total = composeSize(g.FileSizeLo, g.FileSizeHi);
      const remaining = composeSize(g.RemainingSizeLo, g.RemainingSizeHi);
      const progress = total > 0 ? Math.max(0, Math.min(100, Math.round(((total - remaining) / total) * 100))) : 0;
      const status = (g.Status ?? "").toLowerCase();
      out.push({
        downloadId: String(g.NZBID ?? ""),
        title: g.NZBName ?? "",
        status: status.includes("error") || status.includes("failed") ? "failed" : status.includes("paused") ? "paused" : "downloading",
        progress,
        size: total,
        remainingTimeSeconds: undefined,
        errorMessage: undefined,
      });
    }

    const hist = await this.call<NzbHistoryItem[]>("history");
    for (const h of hist ?? []) {
      const status = (h.Status ?? "").toLowerCase();
      const downloadId = String(h.NZBID ?? "");
      if (downloadId === "") continue;
      if (status.includes("success") || status.includes("completed")) {
        out.push({ downloadId, title: h.NZBName ?? "", status: "completed", progress: 100, size: 0 });
      } else if (status.includes("failure") || status.includes("failed")) {
        out.push({ downloadId, title: h.NZBName ?? "", status: "failed", progress: 0, size: 0 });
      }
    }
    return out;
  }

  /**
   * Remove a download. NZBGet's `edit` action operates on both the active queue and history
   * by id; `GroupFinalDelete` removes files too, `GroupDelete` leaves them. Defaults to
   * keeping files (library may hardlink to this data), matching the other providers.
   */
  async remove(downloadId: string, deleteData = false): Promise<void> {
    const id = Number(downloadId);
    const method = deleteData ? "GroupFinalDelete" : "GroupDelete";
    await this.call("edit", [Number.isFinite(id) ? id : downloadId, method]);
  }

  healthcheck(): Promise<HealthResult> {
    return this.healthcheckVia(async () => {
      const v = await this.call<string>("version");
      return { ok: true, message: v ?? undefined };
    });
  }
}

/** Recombine a NZBGet 32-bit lo/hi size pair into a byte count (lo + hi << 32). */
function composeSize(lo?: number, hi?: number): number {
  return (lo ?? 0) + (hi ?? 0) * 4294967296;
}
