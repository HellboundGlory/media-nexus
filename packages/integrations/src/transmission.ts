// SPDX-License-Identifier: MIT
/**
 * Transmission download client provider (RPC v2) — JSON-RPC 2.0 over `POST /transmission/rpc`,
 * with the lazy session-id challenge (HTTP 409 returning `X-Transmission-Session-Id`) as auth.
 * Both wire styles sit on the shared DownloadClientBase transport. If credentials are set, a
 * Basic `Authorization` header is included (Transmission also accepts session-based auth).
 */
import type { ClientQueueItem, AddDownloadInput, HealthResult } from "./contracts";
import type { TransmissionSettings } from "./schemas";
import { DownloadClientBase } from "./base";

interface TrTorrent {
  id?: number;
  hashString?: string;
  name?: string;
  totalSize?: number;
  percentDone?: number; // 0..1
  status?: number; // 0 stopped, 1 check-wait, 2 checking, 3 download-wait, 4 downloading, 5 seed-wait, 6 seeding
  eta?: number;
  downloadDir?: string;
  ratio?: number;
  secondsSeeding?: number;
  error?: number;
  errorString?: string;
}

/** Transmission statuses at or past full download (still present → can show as "completed"). */
const COMPLETED_STATUSES = new Set([5, 6]); // seed-wait, seeding

interface RpcEnvelope<T = unknown> {
  result?: string;
  arguments?: T;
}

export class TransmissionProvider extends DownloadClientBase<TransmissionSettings> {
  readonly key = "transmission";
  readonly kind = "torrent" as const;

  constructor(settings: TransmissionSettings, fetchImpl: typeof fetch = fetch) {
    super(settings, fetchImpl);
    if (settings.username || settings.password) {
      this.headers["Authorization"] = "Basic " + Buffer.from(`${settings.username ?? ""}:${settings.password ?? ""}`).toString("base64");
    }
  }

  /** Issue a Transmission RPC call, transparently resolving the one-shot 409 session-id
   *  challenge, and throw on a non-success result. `arguments` is the call payload. */
  private async rpc<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    const body = { method, arguments: args };
    let res = await this.postRpc(body);
    if (res.status === 409) {
      // Session-id challenge: capture the id and retry once — subsequent calls carry it.
      const session = res.headers.get("X-Transmission-Session-Id");
      if (session) this.headers["X-Transmission-Session-Id"] = session;
      res = await this.postRpc(body);
    }
    if (!res.ok) throw new Error(`Transmission ${method} HTTP ${res.status}`);
    const envelope = (await res.json()) as RpcEnvelope<T>;
    if (envelope.result && envelope.result !== "success") {
      throw new Error(`Transmission ${method} failed: ${envelope.result}`);
    }
    return (envelope.arguments ?? {}) as T;
  }

  private postRpc(call: unknown): Promise<Response> {
    return this.request("/transmission/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(call),
    });
  }

  async addRelease(input: AddDownloadInput): Promise<{ downloadId: string }> {
    const release = input.release;
    const url = release.magnetUrl ?? release.downloadUrl;
    if (!url) throw new Error("Transmission requires a magnet/torrent URL on the release");
    const args: Record<string, unknown> = { filename: url };
    // Per-client category-to-root-folder routing (D3): a category-specific download-dir
    // overrides the generic `downloadDir`.
    const route = this.settings.categoryRoutes?.[input.category ?? ""];
    const downloadDir = route ?? this.settings.downloadDir;
    if (downloadDir) args["download-dir"] = downloadDir;
    const added = await this.rpc<{
      "torrent-added"?: { hashString?: string };
      "torrent-duplicate"?: { hashString?: string };
    }>("torrent-add", args);
    const hash = added["torrent-added"]?.hashString ?? added["torrent-duplicate"]?.hashString;
    if (!hash) throw new Error("Transmission added torrent without a hash");
    return { downloadId: hash };
  }

  async getQueue(): Promise<ClientQueueItem[]> {
    const out = await this.rpc<{ torrents: TrTorrent[] }>("torrent-get", {
      fields: ["hashString", "name", "totalSize", "percentDone", "status", "eta", "downloadDir", "ratio", "secondsSeeding", "error", "errorString"],
    });
    return (out.torrents ?? []).map((t) => {
      const status = t.status ?? 0;
      const completed = COMPLETED_STATUSES.has(status) || (t.percentDone ?? 0) >= 1;
      const failed = (t.error ?? 0) !== 0;
      return {
        downloadId: t.hashString ?? String(t.id ?? ""),
        title: t.name ?? t.hashString ?? "",
        status: completed ? "completed" : failed ? "failed" : status === 0 ? "paused" : "downloading",
        progress: Math.min(100, Math.round((t.percentDone ?? 0) * 100)),
        size: t.totalSize ?? 0,
        remainingTimeSeconds: t.eta && t.eta > 0 ? t.eta : undefined,
        errorMessage: failed ? (t.errorString ?? "transmission error") : undefined,
        contentPath: t.downloadDir ? `${t.downloadDir}/${t.name}` : undefined,
        ratio: t.ratio,
        seedTimeSeconds: t.secondsSeeding,
      };
    });
  }

  /** Remove a torrent. `deleteData` maps to `delete-local-data`; defaults to FALSE to
   *  preserve the payload (and keep hardlinks to the library intact), mirroring qBittorrent. */
  async remove(downloadId: string, deleteData = false): Promise<void> {
    await this.rpc("torrent-remove", { ids: [downloadId], "delete-local-data": deleteData });
  }

  healthcheck(): Promise<HealthResult> {
    return this.healthcheckVia(async () => {
      const v = await this.rpc<{ version?: string }>("session-get", { fields: ["version"] });
      return { ok: true, message: v.version ?? undefined };
    });
  }
}
