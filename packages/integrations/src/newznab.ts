// SPDX-License-Identifier: MIT
/**
 * Newznab / Torznab indexer provider (HTTP).
 *
 * Implements the documented Newznab API (`?t=search&q=...&apikey=...&o=json`, 
 * newznab.readthedocs.io) and the Torznab extension (torrent categories + magnet
 * attrs) — reimplemented against the public spec; no upstream code is used.
 * JSON mode (`o=json`) is requested for easy, stable parsing.
 */
import type { IndexerContract, SearchParams, HealthResult } from "./contracts";
import type { Release } from "@medianexus/domain";
import { parseReleaseTitle } from "@medianexus/domain";
import type { NewznabSettings, TorznabSettings } from "./schemas";

export type NewznabProtocol = "usenet" | "torrent";

export interface NewznabItem {
  title?: string;
  guid?: string;
  link?: string;
  size?: number | string;
  category?: string[];
  enclosure?: { url?: string; length?: number | string; type?: string };
  "newznab:attr"?: { name?: string; value?: string }[];
}

export interface NewznabChannel {
  item?: NewznabItem[];
}

export interface NewznabJson {
  channel?: NewznabChannel;
}

/** Extract a named attr from a newznab item (robust to missing fields). */
export function newznabAttr(item: NewznabItem, name: string): string | undefined {
  const attrs = item["newznab:attr"];
  if (!Array.isArray(attrs)) return undefined;
  return attrs.find((a) => a.name === name)?.value;
}

/** Pure parser: normalized JSON response -> MediaNexus Release[]. */
export function parseNewznabJson(
  json: NewznabJson,
  opts: { indexerId: string; indexerName: string; protocol: NewznabProtocol },
): Release[] {
  const items = json?.channel?.item ?? [];
  const out: Release[] = [];
  for (const item of items) {
    const title = item.title ?? "";
    if (!title && !item.guid) continue;
    const size =
      toNumber(newznabAttr(item, "size")) ?? toNumber(item.size) ?? toNumber(item.enclosure?.length) ?? 0;
    const cats = splitCats(newznabAttr(item, "category") ?? item.category?.join?.(",") ?? "");
    const parsed = parseReleaseTitle(title);
    out.push({
      id: item.guid ?? item.link ?? title,
      indexerId: opts.indexerId,
      indexerName: opts.indexerName,
      title,
      protocol: opts.protocol,
      categories: cats,
      size,
      ageHours: 0,
      seeders: nzNumber(newznabAttr(item, "seeders")),
      leechers: nzNumber(newznabAttr(item, "leechers")),
      peers: nzNumber(newznabAttr(item, "peers")),
      downloadUrl: linkFor(item, opts.protocol),
      magnetUrl: nzString(newznabAttr(item, "magneturl")) ?? (item.link?.startsWith("magnet:") ? item.link : undefined),
      infoUrl: item.guid ?? item.link,
      quality: parsed.quality,
      isFreeleech: newznabAttr(item, "downloadvolumefactor") === "0",
      isProper: /\bproper\b/i.test(title),
      isRepack: /\brepack\b/i.test(title),
    });
  }
  return out;
}

function linkFor(item: NewznabItem, protocol: NewznabProtocol): string | undefined {
  const link = item.link;
  if (!link) return undefined;
  if (protocol === "torrent" && link.startsWith("magnet:")) return link;
  return link;
}

function toNumber(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
function nzNumber(v: string | undefined): number | undefined {
  const n = toNumber(v);
  return n === undefined ? undefined : Math.round(n);
}
function nzString(v: string | undefined): string | undefined {
  return v ? v : undefined;
}
function splitCats(raw: string): number[] {
  if (!raw) return [];
  return raw
    .split(/[,; ]+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** HTTP provider. Validated against Newznab/Torznab settings zod schemas at the API layer. */
export class NewznabProvider implements IndexerContract {

  readonly key: string;
  readonly protocol: NewznabProtocol;
  private readonly settings: NewznabSettings | TorznabSettings;
  private readonly fetchImpl: typeof fetch = fetch;

  constructor(
    key: string,
    protocol: NewznabProtocol,
    settings: NewznabSettings | TorznabSettings,
    fetchImpl?: typeof fetch,
  ) {
    this.key = key;
    this.protocol = protocol;
    this.settings = settings;
    if (fetchImpl) this.fetchImpl = fetchImpl;
  }

  async search(params: SearchParams): Promise<Release[]> {
    const cats = this.settings.categories ?? [];
    const q = new URLSearchParams();
    q.set("t", "search");
    // without `q` this is a category/front-page search (RSS-style); with `q` a title search
    if (params.query) q.set("q", params.query);
    else q.set("cat", cats.join(","));
    if (this.settings.apiKey) q.set("apikey", this.settings.apiKey);
    if (cats.length && params.query) q.set("cat", cats.join(","));
    q.set("extended", "1");
    q.set("o", "json");
    q.set("limit", String(params.limit ?? 100));
    q.set("offset", "0");

    const res = await this.request(`/api?${q.toString()}`);
    const json = (await res.json()) as NewznabJson;
    return parseNewznabJson(json, {
      indexerId: this.key,
      indexerName: this.label(),
      protocol: this.protocol,
    }).slice(0, params.limit ?? 100);
  }

  async healthcheck(): Promise<HealthResult> {
    const started = Date.now();
    try {
      const q = new URLSearchParams({ t: "caps", o: "json" });
      const res = await this.request(`/api?${q.toString()}`);
      const ok = res.ok;
      return { ok, latencyMs: Date.now() - started, message: ok ? undefined : `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private async request(pathWithQuery: string): Promise<Response> {
    const base = this.settings.baseUrl.replace(/\/$/, "");
    const headers: Record<string, string> = {};
    const maybe = this.settings as { username?: string; password?: string };
    if (maybe.username && maybe.password) {
      const b64 = Buffer.from(`${maybe.username}:${maybe.password}`).toString("base64");
      headers["Authorization"] = `Basic ${b64}`;
    }
    return this.fetchImpl(`${base}${pathWithQuery}`, { headers, signal: AbortSignal.timeout(20_000) });
  }

  private label(): string {
    const s = this.settings as { baseUrl?: string };
    return s.baseUrl ?? this.key;
  }
}

export { parseReleaseTitle };
