// SPDX-License-Identifier: MIT
/**
 * Proxy-aware fetch: HTTP(S) CONNECT via http(s)-proxy-agent, SOCKS4/5 via
 * socks-proxy-agent, plus FlareSolverr challenge bypass. Returns a standard
 * `Response` so provider code path is unchanged. Zero-tunnel reimplementation:
 * the tunnel + request is delegated to the well-tested agent packages.
 */
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { ClientRequestArgs } from "node:http";
import type { Agent } from "node:http";

type HeadersShim = Record<string, string> | Headers | [string, string][];
import type { IndexerProxy } from "./schemas";

export type Fetcher = (url: string, init?: RequestInit & { proxyUrl?: string }) => Promise<Response>;

export interface FetcherOptions {
  proxy?: IndexerProxy | null;
  flareSolverrUrl?: string;
  fetchImpl?: typeof fetch;
}

/** Build a fetcher honoring the indexer's proxy + FlareSolverr configuration. */
export function buildFetcher(opts: FetcherOptions): Fetcher {
  return async (url, init = {}) => {
    if (opts.flareSolverrUrl) return flareSolverrFetch(opts.flareSolverrUrl, url, init);
    if (opts.proxy?.enabled && opts.proxy.host) return proxyFetch(url, init, opts.proxy);
    return (opts.fetchImpl ?? fetch)(url, init);
  };
}

async function proxyFetch(url: string, init: RequestInit, proxy: IndexerProxy): Promise<Response> {
  const u = new URL(url);
  const scheme = proxy.type === "socks4" || proxy.type === "socks5" ? "socks" : "http";
  const auth = proxy.username || proxy.password ? `${encodeURIComponent(proxy.username ?? "")}:${encodeURIComponent(proxy.password ?? "")}@` : "";
  const proxyUrl = `${scheme}://${auth}${proxy.host}:${proxy.port}`;

  const agent = agentFor(proxy.type, proxyUrl, u.protocol);
  const body = bodyFromInit(init);
  const headers = flattenHeaders(init.headers as HeadersShim);
  if (body && !("content-length" in headers)) headers["content-length"] = String(Buffer.byteLength(body));

  return new Promise<Response>((resolve, reject) => {
    const options: ClientRequestArgs = {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: init.method ?? "GET",
      headers,
      agent: agent as Agent,
    };
    const req = (u.protocol === "https:" ? httpsRequest : httpRequest)(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c as Buffer));
      res.on("end", () => {
        try {
          resolve(new Response(Buffer.concat(chunks), {
            status: res.statusCode ?? 502,
            statusText: res.statusMessage,
            headers: res.headers as Record<string, string>,
          }));
        } catch (err) { reject(err); }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function agentFor(proxyType: string, proxyUrl: string, targetProtocol: string): unknown {
  if (proxyType === "socks4" || proxyType === "socks5") return new SocksProxyAgent(proxyUrl);
  // http/https proxy: for https targets use CONNECT-tunneling agent, else absolute-form agent
  return targetProtocol === "https:" ? new HttpsProxyAgent(proxyUrl) : new HttpProxyAgent(proxyUrl);
}

async function flareSolverrFetch(flareUrl: string, url: string, _init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 65_000);
  try {
    const res = await fetch(`${flareUrl.replace(/\/$/, "")}/v1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmd: "request.get", url, maxTimeout: 60_000 }),
      signal: controller.signal,
    });
    const payload = (await res.json()) as {
      status?: string;
      solution?: { status?: number; headers?: Record<string, string>; content?: string };
    };
    if (payload.status !== "ok" || !payload.solution) {
      return new Response("", { status: 502, statusText: "flare solver failed" });
    }
    return new Response(payload.solution.content ?? "", {
      status: payload.solution.status ?? 200,
      headers: payload.solution.headers,
    });
  } finally {
    clearTimeout(timer);
  }
}

function flattenHeaders(headers: HeadersShim | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (Array.isArray(headers) || typeof (headers as Headers).forEach === "function") {
    new Headers(headers).forEach((v, k) => (out[k] = v));
  }
  return out;
}

function bodyFromInit(init: RequestInit): Buffer | undefined {
  if (init.body == null) return undefined;
  if (typeof init.body === "string") return Buffer.from(init.body);
  if (init.body instanceof Uint8Array) return Buffer.from(init.body);
  return undefined;
}

export { HttpProxyAgent, HttpsProxyAgent, SocksProxyAgent };
