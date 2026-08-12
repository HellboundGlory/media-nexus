// SPDX-License-Identifier: MIT
/**
 * SABnzbd download client provider (HTTP JSON API) — reimplemented against SABnzbd's
 * documented public API (`api?mode=addurl`, `mode=queue`, `mode=history`).
 * getQueue() merges the active queue (downloading) with completed history slots so
 * the download-monitor can import finished downloads.
 */
import type { DownloadClientContract, ClientQueueItem, AddDownloadInput, HealthResult } from "./contracts";
import type { SabnzbdSettings } from "./schemas";

interface SabSlot {
  nzo_id?: string;
  filename?: string;
  status?: string;
  mb?: number | string;
  mb_left?: number | string;
  percentage?: number | string;
  timeleft?: string;
  path?: string;
  /** history slots report the completed job's final folder here */
  storage?: string;
  category?: string;
}

interface SabResponse {
  status?: boolean;
  error?: string;
  nzo_ids?: string[];
  queue?: { slots?: SabSlot[]; status?: string };
  history?: { slots?: SabSlot[] };
}

export class SabnzbdProvider implements DownloadClientContract {
  readonly key = "sabnzbd";
  readonly kind = "usenet" as const;

  constructor(
    private readonly settings: SabnzbdSettings,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private url(mode: string, extra: Record<string, string> = {}): string {
    const params = new URLSearchParams({
      mode,
      apikey: this.settings.apiKey,
      output: "json",
      ...extra,
    });
    const host = this.settings.host.replace(/\/$/, "");
    return `${host}/api?${params.toString()}`;
  }

  private async get<T>(params: URL, signal?: AbortSignal): Promise<T> {
    const res = await this.fetchImpl(params.toString(), { signal: signal ?? AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`SABnzbd HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async addRelease(input: AddDownloadInput): Promise<{ downloadId: string }> {
    const release = input.release;
    const nzbUrl = release.downloadUrl;
    if (!nzbUrl) throw new Error("SABnzbd requires a usenet nzb URL on the release");
    const params = new URLSearchParams({
      mode: "addurl",
      apikey: this.settings.apiKey,
      name: nzbUrl,
      cat: input.category ?? this.settings.category ?? "movies",
      output: "json",
      pp: "3", // smart post-processing
    });
    const res = (await this.get<SabResponse>(new URL(`${this.host()}/api?${params.toString()}`))) as unknown as SabResponse;
    if (res.error) throw new Error(`SABnzbd addurl failed: ${res.error}`);
    const ids = res.nzo_ids ?? [];
    if (ids.length === 0) throw new Error("SABnzbd did not return an nzo id");
    return { downloadId: ids[0] };
  }

  async getQueue(): Promise<ClientQueueItem[]> {
    const out: ClientQueueItem[] = [];

    const queue = await this.get<SabResponse>(new URL(this.url("queue")));
    for (const s of queue.queue?.slots ?? []) {
      out.push(slotToItem(s, "queued"));
    }

    // completed downloads live in history — surface them so the monitor can import
    const hist = await this.get<SabResponse>(new URL(this.url("history")));
    for (const s of hist.history?.slots ?? []) {
      const status = (s.status ?? "").toLowerCase();
      if (status.includes("completed") || status.includes("done")) {
        out.push(slotToItem(s, "completed"));
      }
    }
    return out;
  }

  /**
   * Remove a download. A finished job lives in SABnzbd's *history*, not its queue, so
   * deleting only from the queue leaves the item visible to getQueue() forever. Both
   * surfaces are cleared; `del_files` is opt-in for the same reason as qBittorrent's
   * deleteFiles (the imported library file may be a hardlink to this data).
   */
  async remove(downloadId: string, deleteData = false): Promise<void> {
    await this.get<SabResponse>(new URL(this.url("queue", { name: "delete", value: downloadId })))
      .catch(() => undefined);
    await this.get<SabResponse>(new URL(this.url("history", {
      name: "delete",
      value: downloadId,
      del_files: deleteData ? "1" : "0",
    }))).catch(() => undefined);
  }

  async healthcheck(): Promise<HealthResult> {
    const started = Date.now();
    try {
      const res = await this.get<SabResponse>(new URL(this.url("queue")));
      return { ok: res.status !== false, latencyMs: Date.now() - started, message: res.error };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private host(): string {
    return this.settings.host.replace(/\/$/, "");
  }
}

function slotToItem(s: SabSlot, fallbackStatus: string): ClientQueueItem {
  const status = (s.status ?? fallbackStatus).toLowerCase();
  const isCompleted = status.includes("completed") || status.includes("done") || status.includes("verifying");
  return {
    downloadId: s.nzo_id ?? "",
    title: s.filename ?? s.nzo_id ?? "unknown",
    status: isCompleted ? "completed" : status.includes("paused") ? "paused" : status.includes("failed") ? "failed" : status.includes("downloading") ? "downloading" : "queued",
    progress: Math.min(100, Math.round(toNum(s.percentage, pairToProgress(s) * 100))),
    size: toNum(s.mb, 0) * 1024 * 1024,
    remainingTimeSeconds: parseTimeleft(s.timeleft),
    errorMessage: undefined,
    // History slots carry the final storage path — pass it through so the importer can
    // use it directly instead of guessing directory layouts under the downloads root.
    contentPath: s.storage || s.path || undefined,
  };
}

function toNum(v: number | string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function pairToProgress(s: SabSlot): number {
  const mb = toNum(s.mb, 0);
  const left = toNum(s.mb_left, mb);
  return mb === 0 ? 0 : (mb - left) / mb;
}
function parseTimeleft(t: string | undefined): number | undefined {
  if (!t || t === "0:00:00") return undefined;
  const parts = t.split(":").map((x) => Number(x));
  if (parts.length !== 3 || parts.some((x) => !Number.isFinite(x))) return undefined;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}
