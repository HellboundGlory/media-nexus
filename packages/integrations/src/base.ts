// SPDX-License-Identifier: MIT
import type {
  AddDownloadInput,
  ClientQueueItem,
  DownloadClientContract,
  HealthResult,
} from "./contracts";

/**
 * Shared HTTP/auth plumbing for download-client providers.
 *
 * Extracts the surface that SABnzbd and qBittorrent historically duplicated:
 * host normalization (trailing-slash strip), an injected `fetch`, cookie capture
 * and a `request()` wrapper with a 15s timeout that throws on a non-ok response.
 *
 * Deliberately THIN — no vendor wire style lives here. The four providers each speak
 * a different protocol (SAB's GET-query API, qBittorrent's cookie login, Transmission's
 * session-id challenge, NZBGet's JSON-RPC envelope), so the base only abstracts the bits
 * they genuinely share: auth state (cookies + static headers), HTTP, host and healthcheck
 * shape. Subclasses provide `key`/`kind` and implement addRelease/getQueue/remove.
 */
export abstract class DownloadClientBase<T extends { host: string }>
  implements DownloadClientContract {
  abstract readonly key: string;
  abstract readonly kind: "usenet" | "torrent";

  protected readonly settings: T;
  protected readonly fetchImpl: typeof fetch;
  /** Captured `Set-Cookie` pairs (e.g. qBittorrent's SID) sent on every request. */
  protected readonly cookies: string[] = [];
  /** Static headers sent on every request (e.g. Transmission's X-Transmission-Session-Id). */
  protected readonly headers: Record<string, string> = {};

  constructor(settings: T, fetchImpl: typeof fetch = fetch) {
    this.settings = settings;
    this.fetchImpl = fetchImpl;
  }

  protected host(): string {
    return this.settings.host.replace(/\/$/, "");
  }

  /** Issue an HTTP request with a 15s timeout, merging captured cookies and static
   *  headers as the transport auth. Throws `HTTP <status>` on a non-ok response. */
  protected async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {
      ...(init.headers as Record<string, string> | undefined),
    };
    if (this.cookies.length) headers["Cookie"] = this.cookies.join("; ");
    Object.assign(headers, this.headers);
    return this.fetchImpl(`${this.host()}${path}`, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(15_000),
    });
  }

  /** Persist `Set-Cookie` headers from a response for all subsequent requests. */
  protected captureCookies(res: Response): void {
    for (const c of res.headers.getSetCookie?.() ?? []) this.cookies.push(c.split(";")[0] ?? c);
    if (this.cookies.length === 0 && res.headers.get("set-cookie")) {
      this.cookies.push(res.headers.get("set-cookie")!.split(";")[0]);
    }
  }

  /** Normalize a health probe into the shared `HealthResult` shape, timing it and
   *  mapping thrown errors to `ok:false`. The probe returns `{ ok, message }`. */
  protected async healthcheckVia(
    probe: () => Promise<{ ok: boolean; message?: string }>,
  ): Promise<HealthResult> {
    const started = Date.now();
    try {
      const r = await probe();
      return { ok: r.ok, latencyMs: Date.now() - started, message: r.message ?? undefined };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  abstract addRelease(input: AddDownloadInput): Promise<{ downloadId: string }>;
  abstract getQueue(): Promise<ClientQueueItem[]>;
  abstract remove(downloadId: string, deleteData?: boolean): Promise<void>;
  abstract healthcheck(): Promise<HealthResult>;
}
