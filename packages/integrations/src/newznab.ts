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
  pubDate?: string;
  "newznab:attr"?: { name?: string; value?: string }[];
}

export interface NewznabChannel {
  item?: NewznabItem[];
  caps?: NewznabCaps;
}

export interface NewznabCaps {
  searching?: {
    search?: { available?: string; supportedParams?: string };
    "tv-search"?: { available?: string; supportedParams?: string };
    "movie-search"?: { available?: string; supportedParams?: string };
  };
  categories?: {
    category?: Array<{ id?: number | string; name?: string }>;
  };
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
      ageHours: toAgeHours(item.pubDate ?? newznabAttr(item, "pubdate")),
      seeders: nzNumber(newznabAttr(item, "seeders")),
      leechers: nzNumber(newznabAttr(item, "leechers")),
      peers: nzNumber(newznabAttr(item, "peers")),
      downloadUrl: linkFor(item, opts.protocol),
      magnetUrl: nzString(newznabAttr(item, "magneturl")) ?? (item.link?.startsWith("magnet:") ? item.link : undefined),
      infoUrl: item.guid ?? item.link,
      quality: parsed.quality,
      // SON-025b: capture both raw volume factors (may be undefined — most feeds lack them);
      // isFreeleech stays derived from the download factor === "0" exactly as before.
      downloadVolumeFactor: toNumber(newznabAttr(item, "downloadvolumefactor")),
      uploadVolumeFactor: toNumber(newznabAttr(item, "uploadvolumefactor")),
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

/** Hours elapsed since a release's `pubDate`. 0 when absent/unparseable (matching the old
 *  hardcoded value). Accepts RFC 2822 (newznab's usual format) and ISO 8601. */
export function toAgeHours(pubDate: string | undefined): number {
  if (!pubDate) return 0;
  const t = Date.parse(pubDate);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 3_600_000));
}

/** Pure parser of a `t=caps&o=json` response into a normalized capabilities map ready to
 *  persist to `indexer.capabilities` (per-indexer, not the shared `indexer_definition` row —
 *  instances sharing a definition can advertise different caps). */
export function parseNewznabCaps(json: NewznabJson): Record<string, unknown> {
  const caps = json?.channel?.caps;
  const searching = caps?.searching ?? {};
  const searchModes: Record<string, { available: boolean; supportedParams: string[] }> = {};
  const entries: Array<[string, keyof NonNullable<NewznabCaps["searching"]>]> = [
    ["search", "search"],
    ["tvsearch", "tv-search"],
    ["movie", "movie-search"],
  ];
  for (const [key, wire] of entries) {
    const node = searching[wire];
    searchModes[key] = {
      available: node?.available === "yes",
      supportedParams: (node?.supportedParams ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    };
  }
  const categories = (caps?.categories?.category ?? [])
    .map((c) => Number(c.id))
    .filter((n) => Number.isFinite(n) && n > 0);
  return { searchModes, categories, fetchedAt: new Date().toISOString() };
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

    // ID-based modes (roadmap D1) win over fuzzy title search when we hold a stable
    // external id — far more accurate on ambiguous titles and remakes. Everything else
    // (query-only movie/series search, and the empty-query category/RSS poll) falls back
    // to `t=search` exactly as before.
    let mode: "search" | "tvsearch" | "movie" = "search";
    if (params.mediaType === "series" && params.tvdbId !== undefined) mode = "tvsearch";
    else if (params.mediaType === "movie" && (params.imdbId !== undefined || params.tmdbId !== undefined)) mode = "movie";

    q.set("t", mode);
    if (mode === "tvsearch") {
      q.set("tvdbid", String(params.tvdbId));
      if (params.season !== undefined) q.set("season", String(params.season));
      if (params.episode !== undefined) q.set("ep", String(params.episode));
      if (params.query) q.set("q", params.query); // optional re-sid for ids that like both
    } else if (mode === "movie") {
      if (params.imdbId) q.set("imdbid", params.imdbId);
      else if (params.tmdbId !== undefined) q.set("tmdbid", String(params.tmdbId));
      if (params.query) q.set("q", params.query);
    } else {
      // without `q` this is a category/front-page search (RSS-style); with `q` a title search
      if (params.query) q.set("q", params.query);
      else if (cats.length) q.set("cat", cats.join(","));
    }

    if (this.settings.apiKey) q.set("apikey", this.settings.apiKey);
    if (cats.length && mode === "search" && params.query) q.set("cat", cats.join(","));
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

  /** Capability detection (`t=caps&o=json`, roadmap D1): parse what search modes / params /
   *  categories this indexer instance advertises, normalized for persistence (core stores
   *  it on the per-indexer `indexer.capabilities` column). */
  async capabilities(): Promise<Record<string, unknown>> {
    const q = new URLSearchParams({ t: "caps", o: "json" });
    const res = await this.request(`/api?${q.toString()}`);
    if (!res.ok) throw new Error(`caps request failed: HTTP ${res.status}`);
    const json = (await res.json()) as NewznabJson;
    return parseNewznabCaps(json);
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
