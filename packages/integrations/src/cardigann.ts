// SPDX-License-Identifier: MIT
/**
 * Cardigann-compatible custom indexer definitions (pragmatic subset, M3).
 *
 * Prowlarr's Cardigann is a YAML "definition format" for indexers with no public API.
 * We reimplement the *format* (documented schema) and a focused interpreter:
 * settings-driven forms, search paths with `${...}` substitutions, HTML scraping via
 * cheerio selectors, plus a JSON mode. Parsing/runtime is our own code — no upstream
 * engine is ported (see docs/legal/provenance.md).
 */
import * as YAML from "yaml";
import * as cheerio from "cheerio";
import { z } from "zod";
import type { IndexerContract, SearchParams, HealthResult } from "./contracts";
import type { Release } from "@medianexus/domain";
import { parseReleaseTitle } from "@medianexus/domain";
import type { Fetcher } from "./proxy";

export type CardigannSettingType = "text" | "password" | "number" | "checkbox" | "select";

export interface CardigannSetting {
  name: string;
  label?: string;
  type: CardigannSettingType;
  default?: string | number | boolean;
  required?: boolean;
  options?: string[];
}

export interface CardigannSearchPath {
  path: string;
  method?: "get" | "post";
  inputs?: Record<string, string>;
  headers?: Record<string, string>;
  /** JSON pointer-ish path to the result array when the endpoint returns JSON */
  jsonResults?: string;
  /** sub-selectors for HTML mode */
  rows?: string;
  title?: string;
  link?: string;
  guid?: string;
  details?: string;
  size?: string;
  seeders?: string;
  leechers?: string;
  peers?: string;
  magnet?: string;
  categories?: string;
}

export interface CardigannDefinition {
  name: string;
  description?: string;
  settings?: CardigannSetting[];
  search: { paths?: CardigannSearchPath[] };
}

export function parseCardigannYaml(text: string): CardigannDefinition {
  const doc = YAML.parse(text) as Record<string, unknown>;
  if (!doc || typeof doc !== "object") throw new Error("Cardigann definition must be a YAML object");
  const name = asString(doc.name);
  if (!name) throw new Error("Cardigann definition requires a `name`");
  const settings = (Array.isArray(doc.settings) ? doc.settings : []).map((s) => {
    const r = s as Record<string, unknown>;
    return {
      name: asString(r.name) ?? "",
      label: asString(r.label),
      type: (asString(r.type) as CardigannSettingType) ?? "text",
      default: (r as { default?: unknown }).default,
      required: Boolean(r.required),
      options: Array.isArray(r.options) ? r.options.map((o) => asString(o) ?? "") : undefined,
    } as CardigannSetting;
  }).filter((s) => s.name);
  const search = (doc.search as Record<string, unknown>) ?? {};
  const paths = (Array.isArray(search.paths) ? search.paths : []).map((p) => parsePath(p));
  return { name, description: asString(doc.description), settings, search: { paths } };
}

function parsePath(p: unknown): CardigannSearchPath {
  const r = (p ?? {}) as Record<string, unknown>;
  const out: CardigannSearchPath = { path: asString(r.path) ?? "/" };
  if (r.method) out.method = asString(r.method) as "get" | "post";
  if (r.inputs && typeof r.inputs === "object") out.inputs = r.inputs as Record<string, string>;
  if (r.headers && typeof r.headers === "object") out.headers = r.headers as Record<string, string>;
  if (r.jsonResults) out.jsonResults = asString(r.jsonResults);
  for (const k of ["rows", "title", "link", "guid", "details", "size", "seeders", "leechers", "peers", "magnet", "categories"]) {
    const v = (r as Record<string, unknown>)[k];
    if (typeof v === "string") (out as unknown as Record<string, string>)[k] = v;
  }
  return out;
}

/** Zod schema for a Cardigann definition's settings → validated at indexer-create time. */
export function cardigannSettingsSchema(def: CardigannDefinition): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const s of def.settings ?? []) {
    let zs: z.ZodTypeAny = z.string();
    if (s.type === "number") zs = z.coerce.number();
    else if (s.type === "checkbox") zs = z.boolean();
    else if (s.type === "password") zs = z.string();
    else if (s.type === "select") zs = z.string();
    shape[s.name] = s.required && s.default === undefined ? zs : zs.optional();
  }
  return z.object(shape);
}

/** Substitute `${settingName}` / `${query.xxx}` / `${Config.xxx}` in strings. */
export function substitute(
  tpl: string,
  settings: Record<string, unknown>,
  ctx: { query?: string },
): string {
  return tpl.replace(/\$\{([^}]+)\}/g, (_m, expr: string) => {
    const dot = expr.indexOf(".");
    if (dot === -1) return String(settings[expr] ?? "");
    const kind = expr.slice(0, dot);
    const key = expr.slice(dot + 1);
    if (kind === "query") return String(ctx.query ?? "");
    if (kind === "Config") return ""; // not supported yet
    return String(settings[key] ?? "");
  });
}

/**
 * Cardigann HTTP provider. `definitionText` = the YAML, `settings` = the configured
 * values (validated), `proxy`/`flareSolverrUrl` routed through the fetch builder.
 */
export class CardigannProvider implements IndexerContract {
  readonly key: string;
  readonly protocol: "usenet" | "torrent";
  private readonly def: CardigannDefinition;
  private readonly settings: Record<string, unknown>;
  private readonly fetcher: Fetcher;
  private readonly baseUrl: string;

  constructor(opts: {
    key: string;
    protocol: "usenet" | "torrent";
    definitionText: string;
    settings: Record<string, unknown>;
    fetcher?: Fetcher;
  }) {
    this.key = opts.key;
    this.protocol = opts.protocol;
    this.def = parseCardigannYaml(opts.definitionText);
    this.settings = opts.settings;
    this.fetcher = opts.fetcher ?? fetch;
    this.baseUrl = String(this.settings["baseUrl"] ?? "").replace(/\/$/, "");
  }

  get definitionName(): string {
    return this.def.name;
  }

  async search(params: SearchParams): Promise<Release[]> {
    if (!params.query) return [];
    const paths = this.def.search.paths ?? [];
    const releases: Release[] = [];
    for (const p of paths) {
      const url = this.buildUrl(p, params.query);
      const headers = (p.headers ? Object.fromEntries(Object.entries(p.headers).map(([k, v]) => [k, substitute(String(v), this.settings, { query: params.query })])) : undefined) as Record<string, string> | undefined;
      const fetcherHeader = headers ?? ({} as Record<string, string>);
      const resp = await this.fetcher(url, { headers: p.method === "post" ? { "content-type": "application/x-www-form-urlencoded", ...fetcherHeader } : fetcherHeader });
      const body = await resp.text();
      const parsed = this.parseResponse(p, body);
      releases.push(...parsed);
    }
    return releases;
  }

  async healthcheck(): Promise<HealthResult> {
    const started = Date.now();
    try {
      const url = this.baseUrl && this.baseUrl.includes("://") ? this.baseUrl : this.baseUrl || "missing-base-url";
      const resp = await this.fetcher(url, { method: "GET" });
      return { ok: resp.ok, latencyMs: Date.now() - started, message: resp.ok ? undefined : `HTTP ${resp.status}` };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private buildUrl(p: CardigannSearchPath, query: string): string {
    const base = this.baseUrl.includes("://") ? this.baseUrl : `https://${this.baseUrl}`;
    const inputs = p.inputs ?? {};
    let path = substitute(p.path, this.settings, { query });
    if (p.method !== "post") {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(inputs)) {
        qs.set(k, substitute(String(v), this.settings, { query }));
      }
      path += path.includes("?") ? "&" : "?";
      path += qs.toString();
    }
    return `${base}${path}`;
  }

  private parseResponse(p: CardigannSearchPath, body: string): Release[] {
    if (p.jsonResults) return this.parseJson(p, body);
    if (p.rows) return this.parseHtml(p, body);
    return [];
  }

  private parseJson(p: CardigannSearchPath, body: string): Release[] {
    const data = JSON.parse(body) as unknown;
    const arr = resolveJsonPath(data, p.jsonResults ?? "") as Record<string, unknown>[];
    if (!Array.isArray(arr)) return [];
    return arr.map((it, i) => this.releaseFromRecord(p, it, String(i))).filter(Boolean) as Release[];
  }

  private parseHtml(p: CardigannSearchPath, body: string): Release[] {
    const $ = cheerio.load(body);
    const out: Release[] = [];
    $(p.rows ?? "").each((i, el) => {
      const row = $(el);
      const title = text(row, p.title);
      const link = attr(row, p.link);
      if (!title || !link) return;
      out.push({
        id: attr(row, p.guid) ?? link,
        indexerId: this.key,
        indexerName: this.def.name,
        title,
        protocol: this.protocol,
        categories: parseCats(attr(row, p.categories)),
        size: parseSize(text(row, p.size)) ?? 0,
        ageHours: 0,
        seeders: num(attr(row, p.seeders) ?? text(row, p.seeders ?? "")),
        downloadUrl: link,
        magnetUrl: attr(row, p.magnet) ?? undefined,
        infoUrl: attr(row, p.details) ?? link,
        quality: parseReleaseTitle(title).quality,
        isFreeleech: false,
        isProper: /\bproper\b/i.test(title),
        isRepack: /\brepack\b/i.test(title),
      });
    });
    return out;
  }

  private releaseFromRecord(p: CardigannSearchPath, it: Record<string, unknown>, i: string): Release | null {
    const title = pick(it, p.title) as string | undefined;
    const link = pick(it, p.link) as string | undefined;
    if (!title) return null;
    return {
      id: (pick(it, p.guid) as string | undefined) ?? link ?? i,
      indexerId: this.key,
      indexerName: this.def.name,
      title,
      protocol: this.protocol,
      categories: [],
      size: Number(pick(it, p.size) ?? 0) || 0,
      ageHours: 0,
      seeders: num(pick(it, p.seeders)),
      leechers: num(pick(it, p.leechers)),
      downloadUrl: link,
      magnetUrl: (pick(it, p.magnet) as string | undefined) ?? undefined,
      infoUrl: (pick(it, p.details) as string | undefined) ?? link,
      quality: parseReleaseTitle(title).quality,
      isFreeleech: false,
      isProper: /\bproper\b/i.test(title),
      isRepack: /\brepack\b/i.test(title),
    };
  }
}

function asString(v: unknown): string | undefined {
  return v == null ? undefined : String(v);
}
function attr($el: cheerio.Cheerio<any>, sel: string | undefined): string | undefined {
  if (!sel) return undefined;
  if (sel.startsWith("@")) return $el.attr(sel.slice(1)) ?? undefined;
  // form like "col a@href" or "a@href"
  const m = /^(.+)@([a-z-]+)$/i.exec(sel.trim());
  if (m) return $el.find(m[1].trim()).attr(m[2]) ?? undefined;
  return $el.attr(sel) ?? undefined;
}
function text($el: cheerio.Cheerio<any>, sel: string | undefined): string {
  if (!sel) return "";
  const s = sel.trim();
  if (s.startsWith("@")) return $el.attr(s.slice(1)) ?? "";
  return $el.find(s).first().text().trim() || $el.text().trim();
}
function num(v: unknown): number | undefined {
  const n = Number(v);
  if (typeof v === "string") return Number(v.replace(/[^0-9.]/g, "")) || undefined;
  return Number.isFinite(n) ? n : undefined;
}
function parseCats(v: string | undefined): number[] {
  return (v ?? "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
}
function parseSize(v: string): number | undefined {
  if (!v) return undefined;
  const m = /([\d.]+)\s*([KMGT]?i?B)/i.exec(v);
  if (!m) return Number(v) || undefined;
  const unit = m[2].toUpperCase();
  const mult = unit.startsWith("K") ? 1024 : unit.startsWith("M") ? 1024 ** 2 : unit.startsWith("G") ? 1024 ** 3 : unit.startsWith("T") ? 1024 ** 4 : 1;
  return Math.round(Number(m[1]) * mult);
}
function resolveJsonPath(data: unknown, path: string): unknown {
  return path.split(".").filter(Boolean).reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), data);
}
function pick(it: Record<string, unknown>, sel: string | undefined): unknown {
  if (!sel) return undefined;
  if (sel.startsWith("@")) return it[sel.slice(1)];
  return sel.split(".").reduce<unknown>((a, k) => (a && typeof a === "object" ? (a as Record<string, unknown>)[k] : undefined), it);
}

export { YAML, z };
