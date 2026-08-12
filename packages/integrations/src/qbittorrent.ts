// SPDX-License-Identifier: MIT
/**
 * qBittorrent download client provider (Web API v2) — reimplemented against qBittorrent's
 * documented API (`/api/v2/auth/login`, `/api/v2/torrents/add`, `/api/v2/torrents/info`,
 * `/api/v2/torrents/delete`). Optional login stores the SID cookie for subsequent calls.
 */
import type { DownloadClientContract, ClientQueueItem, AddDownloadInput, HealthResult } from "./contracts";
import type { QbittorrentSettings } from "./schemas";

interface TorrentInfo {
  hash?: string;
  name?: string;
  size?: number;
  progress?: number; // 0..1
  state?: string;
  eta?: number; // seconds
  category?: string;
  content_path?: string;
  save_path?: string;
  amount_left?: number;
}

const COMPLETED_STATES = new Set(["uploading", "stalledUP", "pausedUP", "queuedUP", "forcedUP", "checkingUP", "moving"]);

export class QbittorrentProvider implements DownloadClientContract {
  readonly key = "qbittorrent";
  readonly kind = "torrent" as const;
  private readonly cookie: string[] = [];

  constructor(
    private readonly settings: QbittorrentSettings,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async ensureLogin(): Promise<void> {
    if (!this.settings.username && !this.settings.password) return; // auth disabled / bypass
    if (this.cookie.length) return;
    const body = new URLSearchParams({ username: this.settings.username ?? "", password: this.settings.password ?? "" });
    const res = await this.fetchImpl(`${this.host()}/api/v2/auth/login`, { method: "POST", body, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`qBittorrent login failed HTTP ${res.status}`);
    for (const c of res.headers.getSetCookie?.() ?? []) this.cookie.push(c.split(";")[0] ?? c);
    if (this.cookie.length === 0 && res.headers.get("set-cookie")) {
      this.cookie.push(res.headers.get("set-cookie")!.split(";")[0]);
    }
  }

  private host(): string {
    return this.settings.host.replace(/\/$/, "");
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    await this.ensureLogin();
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
    if (this.cookie.length) headers["Cookie"] = this.cookie.join("; ");
    return this.fetchImpl(`${this.host()}${path}`, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(15_000) });
  }

  async addRelease(input: AddDownloadInput): Promise<{ downloadId: string }> {
    const release = input.release;
    const url = release.magnetUrl ?? release.downloadUrl;
    if (!url) throw new Error("qBittorrent requires a magnet/torrent URL on the release");
    const body = new URLSearchParams({
      urls: url,
      category: input.category ?? this.settings.category ?? "movies",
      tags: this.settings.tag ?? "media-nexus",
    });
    if (this.settings.savePath) body.set("savepath", this.settings.savePath);
    const res = await this.request("/api/v2/torrents/add", { method: "POST", body });
    if (!res.ok) throw new Error(`qBittorrent add failed HTTP ${res.status}`);
    const text = (await res.text()).trim();
    if (text && text !== "Ok." && text !== "OK") throw new Error(`qBittorrent add failed: ${text}`);
    // qBt doesn't return the hash from /add — poll /info until the new torrent shows up
    const wantHash = infohashFromUrl(url)?.toLowerCase();
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 200 * (i + 1)));
      const list = await this.getTorrents().catch(() => []);
      const found = list.find((t) => t.hash && wantHash && t.hash.toLowerCase() === wantHash) ?? list.find((t) => t.name === release.title);
      if (found?.hash) return { downloadId: found.hash };
    }
    throw new Error("qBittorrent added torrent but could not resolve its hash");
  }

  async getQueue(): Promise<ClientQueueItem[]> {
    const list = await this.getTorrents();
    return list.map((t) => {
      const completed = COMPLETED_STATES.has(t.state ?? "") || (t.progress ?? 0) >= 1;
      return {
        downloadId: t.hash ?? "",
        title: t.name ?? t.hash ?? "",
        status: completed ? "completed" : t.state === "paused" || t.state === "pausedDL" ? "paused" : t.state?.includes("failing") || t.state === "error" ? "failed" : "downloading",
        progress: Math.min(100, Math.round((t.progress ?? 0) * 100)),
        size: t.size ?? 0,
        remainingTimeSeconds: t.eta && t.eta > 0 ? t.eta : undefined,
        errorMessage: undefined,
        contentPath: t.content_path,
      };
    });
  }

  /**
   * Remove a torrent from the client. `deleteData` defaults to FALSE: the library file is
   * usually a hardlink to the downloaded data, and deleting that data stops the torrent
   * seeding — which on private trackers costs ratio and, eventually, the account. Callers
   * that genuinely want the payload gone (a failed download being cleaned up) opt in.
   */
  async remove(downloadId: string, deleteData = false): Promise<void> {
    const body = new URLSearchParams({ hashes: downloadId, deleteFiles: deleteData ? "true" : "false" });
    await this.request("/api/v2/torrents/delete", { method: "POST", body });
  }

  async healthcheck(): Promise<HealthResult> {
    const started = Date.now();
    try {
      const res = await this.request("/api/v2/app/version");
      return { ok: res.ok, latencyMs: Date.now() - started, message: res.ok ? undefined : `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private async getTorrents(): Promise<TorrentInfo[]> {
    const res = await this.request("/api/v2/torrents/info");
    if (!res.ok) throw new Error(`qBittorrent torrents/info HTTP ${res.status}`);
    return (await res.json()) as TorrentInfo[];
  }
}

function infohashFromUrl(url: string): string | undefined {
  const m = /[?&]xt=urn:btih:([0-9a-fA-F]{40}|[A-Za-z2-7]{32})/.exec(url);
  return m?.[1] ?? undefined;
}

export { COMPLETED_STATES };
