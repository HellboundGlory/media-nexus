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
  // Completion path (NZBGET-2): listgroups reports the output destination directory — the
  // importer needs this to locate the downloaded files instead of guessing conventional
  // usenet layouts that don't match NZBGet's real "completed/<Category>/<title>" default.
  // FinalDir is set only by a post-processing script; otherwise the item is at DestDir.
  DestDir?: string;
  FinalDir?: string;
}

interface NzbHistoryItem {
  NZBID?: number;
  NZBName?: string;
  Status?: string;
  Category?: string;
  // Completion path (NZBGET-2): HISTORY.md documents both DestDir ("Destination directory for
  // output file") and FinalDir (set by post-processing when it moved the output). Prefer
  // FinalDir when present, else DestDir — the same resolution as the active-queue loop.
  DestDir?: string;
  FinalDir?: string;
}

interface RpcError {
  message?: string;
}

export class NzbgetProvider extends DownloadClientBase<NzbgetSettings> {
  readonly key = "nzbget";
  readonly kind = "usenet" as const;

  constructor(settings: NzbgetSettings, fetchImpl: typeof fetch = fetch) {
    super(settings, fetchImpl);
    // NZBGet authenticates with HTTP Basic (its JSON-RPC runs over the WebGet API). NZBGet's own
    // docs describe credentials embedded in the URL, but Node's native fetch refuses
    // credentials-in-URL, so send the Authorization header explicitly — same mechanism and
    // pattern as Transmission. Only set when a credential is provided; otherwise send unauthenticated.
    if (settings.username || settings.password) {
      this.headers["Authorization"] = "Basic " + Buffer.from(`${settings.username ?? ""}:${settings.password ?? ""}`).toString("base64");
    }
  }

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
    // append(Filename, Content, Category, Priority, AddToTop, AddPaused, DupeKey, DupeScore,
    //        DupeMode, AutoCategory, PPParameters) — 11 positional args per NZBGet's API.md.
    // Filename is "" and Content is the URL: NZBGet reads the filename from the URL's headers and
    // determines URL-vs-content itself (there is NO AddUrl param). DupeMode "SCORE" per APPEND.md's
    // example; AutoCategory false (category is explicit); PPParameters [].
    const nzoId = await this.call<number>("append", [
      "", nzbUrl, input.category ?? this.settings.category ?? "movies",
      this.settings.priority ?? 0, false, false, "", 0, "SCORE", false, [],
    ]);
    if (nzoId === undefined || nzoId === null) throw new Error("NZBGet append returned no id");
    return { downloadId: String(nzoId) };
  }

  async getQueue(): Promise<ClientQueueItem[]> {
    const out: ClientQueueItem[] = [];

    // listgroups(int NumberOfLogEntries) — the param is mandatory even though deprecated, must be 0.
    const groups = await this.call<NzbGroup[]>("listgroups", [0]);
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
        contentPath: g.FinalDir || g.DestDir || undefined,
      });
    }

    const hist = await this.call<NzbHistoryItem[]>("history", [false]);
    for (const h of hist ?? []) {
      const status = (h.Status ?? "").toLowerCase();
      const downloadId = String(h.NZBID ?? "");
      if (downloadId === "") continue;
      if (status.includes("success") || status.includes("completed")) {
        out.push({ downloadId, title: h.NZBName ?? "", status: "completed", progress: 100, size: 0, contentPath: h.FinalDir || h.DestDir || undefined });
      } else if (status.includes("failure") || status.includes("failed")) {
        out.push({ downloadId, title: h.NZBName ?? "", status: "failed", progress: 0, size: 0, contentPath: h.FinalDir || h.DestDir || undefined });
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
    if (!Number.isFinite(id)) throw new Error(`NZBGet remove: invalid download id "${downloadId}"`);
    // Usenet downloads resolve quickly (complete or fail), so the item is usually already in
    // HISTORY, not the active queue — Group-level commands only match the active queue and return
    // `false` when nothing matched. Try the queue first, then fall back to history.
    // File-deletion semantics (verified against HistoryCoordinator.cpp HistoryDelete): both
    // History commands run DeleteDiskFiles for NZB items, so the download is removed from disk
    // either way; the `final` flag (HistoryFinalDelete) additionally erases the history record
    // outright, while HistoryDelete keeps it as a hidden DUP record.
    const groupMethod = deleteData ? "GroupFinalDelete" : "GroupDelete";
    const removedFromQueue = await this.call<boolean>("editqueue", [groupMethod, "", [id]]);
    if (removedFromQueue) return;
    const historyMethod = deleteData ? "HistoryFinalDelete" : "HistoryDelete";
    await this.call<boolean>("editqueue", [historyMethod, "", [id]]);
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
