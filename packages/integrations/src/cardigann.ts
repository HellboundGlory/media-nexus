// SPDX-License-Identifier: MIT
/**
 * Cardigann-compatible custom indexer definitions (roadmap D4, Stage 1 — interpreter
 * rewrite to the real upstream v11 model).
 *
 * Reimplements the Cardigann YAML *format* (documented schema, measured against the actual
 * Prowlarr/Indexers v11 corpus — see RESEARCH/CARDIGANN_V11_SPEC.md) with our own
 * parser/runtime: no upstream engine is ported (see docs/legal/provenance.md).
 *
 * What this stage adds over the old flat model:
 *  - `search.rows` (RowsBlock) and `search.fields` (FieldsBlock) defined separately,
 *    matching upstream (the old combined flat shape is rejected at parse time).
 *  - Go-template substitution (`{{ .X }}`, `if/else`, `range`) instead of `${...}`.
 *  - SelectorBlock evaluation (selector/attribute/case/remove/text/default/optional).
 *  - FilterBlock pipeline (see cardigann-filters.ts).
 *  - JSON + XML response modes alongside HTML.
 *  - Field evaluation in YAML declaration order with `.Result.<field>` chaining.
 *  - An opaque `sessionState` accessor (plain text until the Stage 2 login engine wires the
 *    J9 AES-256-GCM codec into the DB read/write path).
 *
 * `login:` (Stage 2) and captcha (excluded project-wide) are out of scope: definitions that
 * gate on them are parsed but will not produce a working search yet.
 */
import * as YAML from "yaml";
import * as cheerio from "cheerio";
import { z } from "zod";
import type { IndexerContract, SearchParams, HealthResult } from "./contracts";
import type { Release } from "@medianexus/domain";
import { parseReleaseTitle } from "@medianexus/domain";
import type { Fetcher } from "./proxy";
import { CompiledTemplate, renderTemplate, templateFunctionNames, type TemplateContext, type TplFunc } from "./cardigann-template";
import {
  applyFilter, isFilterSupported, UnsupportedFilterError,
  type FilterArg, type FilterArgs,
} from "./cardigann-filters";
import { CookieJar } from "./cardigann-login";

export type CardigannSettingType = "text" | "password" | "number" | "checkbox" | "select" | "info";

export interface CardigannSetting {
  name: string;
  label?: string;
  type: CardigannSettingType;
  default?: string | number | boolean;
  required?: boolean;
  options?: string[];
}

export interface FilterBlock {
  name: string;
  args?: FilterArgs;
}

export interface SelectorBlock {
  /** CSS selector (HTML/XML) or JSON path (JSON mode). */
  selector?: string;
  /** Attribute to read from the selected element (HTML/XML). */
  attribute?: string;
  optional?: boolean;
  default?: string | number;
  /** selector → value map ('*' = fallback). */
  case?: Record<string, string | number>;
  /** HTML: sub-selector removed before text extraction. */
  remove?: string;
  /** Literal value; may be a Go template (rendered against Config/Result/...). */
  text?: string | number;
  filters?: FilterBlock[];
}

export interface RowFilterBlock {
  name: "andmatch" | "strdump";
  args?: string | number;
}

export interface RowsBlock {
  selector?: string;
  attribute?: string;
  optional?: boolean;
  multiple?: boolean;
  missingAttributeEqualsNoResults?: boolean;
  case?: Record<string, string>;
  remove?: string;
  text?: string | number;
  filters?: RowFilterBlock[];
  count?: SelectorBlock;
  dateheaders?: SelectorBlock;
  after?: number;
}

export type FieldsBlock = Record<string, SelectorBlock>;

export interface ResponseBlock {
  type: "json" | "xml";
  noResultsMessage?: string;
}

export interface CardigannSearchPath {
  path: string;
  method?: "get" | "post";
  followredirect?: boolean;
  categories?: (number | string)[];
  inheritinputs?: boolean;
  queryseparator?: string;
  inputs?: Record<string, string | number | boolean>;
  response?: ResponseBlock;
}

export interface CardigannSearchBlock {
  path?: string;
  paths?: CardigannSearchPath[];
  inputs?: Record<string, string | number | boolean>;
  headers?: Record<string, string[]>;
  allowEmptyInputs?: boolean;
  keywordsfilters?: FilterBlock[];
  preprocessingfilters?: FilterBlock[];
  rows?: RowsBlock;
  fields?: FieldsBlock;
}

export type CardigannLoginMethod = "form" | "post" | "cookie" | "get" | "oneurl";

export interface LoginErrorBlock {
  /** Optional path whose response should be checked for login failure. */
  path?: string;
  selector?: string;
  message?: SelectorBlock;
}

export interface LoginTestBlock {
  path: string;
  selector?: string;
}

export interface CardigannLoginBlock {
  method?: CardigannLoginMethod;
  /** Login endpoint (relative or absolute). */
  path?: string;
  /** Explicit form submission path (form method). */
  submitpath?: string;
  /** CSS selector for the login <form> on the login page (form method). */
  form?: string;
  /** Cookie names the site sets after login. */
  cookies?: string[];
  inputs?: Record<string, string | number | boolean>;
  /** Dynamically extracted hidden login fields (evaluated against the login page DOM). */
  selectorinputs?: Record<string, SelectorBlock>;
  getselectorinputs?: Record<string, SelectorBlock>;
  /** Whether to scrape hidden inputs from the login <form> (form method). */
  selectors?: boolean;
  /** Detect login failure in a response. */
  error?: LoginErrorBlock[];
  /** Verify a logged-in session. */
  test?: LoginTestBlock;
  headers?: Record<string, string[]>;
  /** Presence of a captcha challenge (unsupported project-wide). */
  captcha?: boolean;
}

export interface CardigannDefinition {
  name: string;
  description?: string;
  settings: CardigannSetting[];
  search: CardigannSearchBlock;
  login?: CardigannLoginBlock;
  /** Filter names this definition uses that this interpreter cannot execute. */
  unsupportedFilters: string[];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export function parseCardigannYaml(text: string): CardigannDefinition {
  const doc = YAML.parse(text) as Record<string, unknown> | null;
  if (!doc || typeof doc !== "object") throw new Error("Cardigann definition must be a YAML object");
  const name = asString(doc.name);
  if (!name) throw new Error("Cardigann definition requires a `name`");
  const settings = parseSettings(doc.settings);
  const searchDoc = (doc.search ?? {}) as Record<string, unknown>;
  const search = parseSearch(searchDoc);
  const unsupportedFilters = collectUnsupportedFilters(search);
  const login = doc.login && typeof doc.login === "object" ? parseLogin(doc.login as Record<string, unknown>) : undefined;
  const out: CardigannDefinition = { name, description: asString(doc.description), settings, search, unsupportedFilters };
  if (login) out.login = login;
  return out;
}

function parseLogin(r: Record<string, unknown>): CardigannLoginBlock {
  const out: CardigannLoginBlock = {};
  const method = asString(r.method) as CardigannLoginMethod | undefined;
  if (method && ["form", "post", "cookie", "get", "oneurl"].includes(method)) out.method = method;
  if (r.path) out.path = asString(r.path);
  if (r.submitpath) out.submitpath = asString(r.submitpath);
  if (r.form) out.form = asString(r.form);
  if (Array.isArray(r.cookies)) out.cookies = r.cookies.map((c) => asString(c) ?? "");
  if (r.inputs && typeof r.inputs === "object") out.inputs = r.inputs as Record<string, string | number | boolean>;
  const selInputs = (r.selectorinputs ?? {}) as Record<string, unknown>;
  if (selInputs && typeof selInputs === "object" && Object.keys(selInputs).length) {
    out.selectorinputs = {};
    for (const [k, v] of Object.entries(selInputs)) out.selectorinputs[k] = parseSelector(v);
  }
  const getSel = (r.getselectorinputs ?? {}) as Record<string, unknown>;
  if (getSel && typeof getSel === "object" && Object.keys(getSel).length) {
    out.getselectorinputs = {};
    for (const [k, v] of Object.entries(getSel)) out.getselectorinputs[k] = parseSelector(v);
  }
  if (typeof r.selectors === "boolean") out.selectors = r.selectors;
  if (Array.isArray(r.error)) {
    out.error = (r.error as Record<string, unknown>[]).map((e) => {
      const eb: LoginErrorBlock = {};
      if (e.path) eb.path = asString(e.path);
      if (e.selector) eb.selector = asString(e.selector);
      if (e.message && typeof e.message === "object") eb.message = parseSelector(e.message);
      return eb;
    });
  }
  if (r.test && typeof r.test === "object") {
    const t = r.test as Record<string, unknown>;
    if (t.path) { out.test = { path: asString(t.path) ?? "", selector: asString(t.selector) }; }
  }
  if (r.headers && typeof r.headers === "object") out.headers = r.headers as Record<string, string[]>;
  if (r.captcha) out.captcha = true;
  return out;
}

function parseSettings(raw: unknown): CardigannSetting[] {
  if (!Array.isArray(raw)) return [];
  const out: CardigannSetting[] = [];
  for (const s of raw) {
    const r = (s ?? {}) as Record<string, unknown>;
    const nm = asString(r.name);
    if (!nm) continue;
    out.push({
      name: nm,
      label: asString(r.label),
      type: (asString(r.type) as CardigannSettingType) ?? "text",
      default: (r as { default?: string | number | boolean }).default,
      required: Boolean(r.required),
      options: Array.isArray(r.options) ? Object.values(r.options).map((o) => asString(o) ?? "") : undefined,
    });
  }
  return out;
}

/** Detect whether a `search` block uses the old flat shape (rows + field selectors on one path). */
function isOldFlatShape(searchDoc: Record<string, unknown>): boolean {
  const hasRowsBlock = searchDoc.rows !== undefined && typeof searchDoc.rows === "object";
  const hasFieldsBlock = searchDoc.fields !== undefined && typeof searchDoc.fields === "object";
  // The old shape put `rows` (string) and field selectors (title/link/size/...) directly
  // on each path, with no search-level rows/fields blocks.
  if (hasRowsBlock && hasFieldsBlock) return false;
  const anyPath = (searchDoc.paths ?? [] as unknown[]) as Record<string, unknown>[];
  const oldPath = anyPath.some((p) => typeof (p as Record<string, unknown>).rows === "string");
  return oldPath;
}

function parseSearch(searchDoc: Record<string, unknown>): CardigannSearchBlock {
  if (isOldFlatShape(searchDoc)) {
    throw new Error(
      "This Cardigann definition uses the old flat-shape model (rows + field selectors on a single path). " +
      "The new model requires a `search.rows` block and a `search.fields` block. Please migrate the " +
      "definition: move `rows` into `search.rows.selector` and each field selector into `search.fields.<name>`.",
    );
  }
  const search: CardigannSearchBlock = {};
  const pathStr = asString(searchDoc.path);
  const pathsArr = Array.isArray(searchDoc.paths) ? searchDoc.paths : [];
  if (pathStr !== undefined) {
    search.path = pathStr;
    search.paths = [parsePath({ path: pathStr })];
  } else if (pathsArr.length) {
    search.paths = pathsArr.map((p) => parsePath(p));
  } else {
    search.paths = [];
  }
  if (searchDoc.inputs && typeof searchDoc.inputs === "object") search.inputs = searchDoc.inputs as Record<string, string | number | boolean>;
  if (searchDoc.headers && typeof searchDoc.headers === "object") search.headers = searchDoc.headers as Record<string, string[]>;
  if (typeof searchDoc.allowEmptyInputs === "boolean") search.allowEmptyInputs = searchDoc.allowEmptyInputs;
  if (Array.isArray(searchDoc.keywordsfilters)) search.keywordsfilters = parseFilters(searchDoc.keywordsfilters);
  if (Array.isArray(searchDoc.preprocessingfilters)) search.preprocessingfilters = parseFilters(searchDoc.preprocessingfilters);
  if (searchDoc.rows && typeof searchDoc.rows === "object") search.rows = parseRows(searchDoc.rows as Record<string, unknown>);
  if (searchDoc.fields && typeof searchDoc.fields === "object") {
    search.fields = {} as FieldsBlock;
    for (const [k, v] of Object.entries(searchDoc.fields as Record<string, unknown>)) {
      search.fields[k] = parseSelector(v);
    }
  }
  return search;
}

function parsePath(p: unknown): CardigannSearchPath {
  const r = (p ?? {}) as Record<string, unknown>;
  const out: CardigannSearchPath = { path: asString(r.path) ?? "/" };
  if (r.method) out.method = asString(r.method)?.toLowerCase() === "post" ? "post" : "get";
  if (typeof r.followredirect === "boolean") out.followredirect = r.followredirect;
  if (Array.isArray(r.categories)) out.categories = r.categories as (number | string)[];
  if (typeof r.inheritinputs === "boolean") out.inheritinputs = r.inheritinputs;
  if (r.queryseparator) out.queryseparator = asString(r.queryseparator);
  if (r.inputs && typeof r.inputs === "object") out.inputs = r.inputs as Record<string, string | number | boolean>;
  const resp = (r.response ?? {}) as Record<string, unknown>;
  if (resp && typeof resp.type === "string" && (resp.type === "json" || resp.type === "xml")) {
    out.response = { type: resp.type, noResultsMessage: asString(resp.noResultsMessage) };
  }
  return out;
}

function parseRows(r: Record<string, unknown>): RowsBlock {
  const out: RowsBlock = {};
  if (r.selector) out.selector = String(r.selector);
  if (r.attribute) out.attribute = String(r.attribute);
  if (typeof r.optional === "boolean") out.optional = r.optional;
  if (typeof r.multiple === "boolean") out.multiple = r.multiple;
  if (typeof r.missingAttributeEqualsNoResults === "boolean") out.missingAttributeEqualsNoResults = r.missingAttributeEqualsNoResults;
  if (r.case && typeof r.case === "object") out.case = r.case as Record<string, string>;
  if (r.remove) out.remove = String(r.remove);
  if (r.text !== undefined) out.text = r.text as string | number;
  if (Array.isArray(r.filters)) out.filters = (r.filters as Record<string, unknown>[]).map((f) => ({
    name: asString(f.name) === "strdump" ? "strdump" : "andmatch",
    args: f.args as string | number | undefined,
  }));
  if (r.count && typeof r.count === "object") out.count = parseSelector(r.count);
  if (r.dateheaders && typeof r.dateheaders === "object") out.dateheaders = parseSelector(r.dateheaders);
  if (typeof r.after === "number") out.after = r.after;
  return out;
}

function parseSelector(v: unknown): SelectorBlock {
  const r = (v ?? {}) as Record<string, unknown>;
  const out: SelectorBlock = {};
  if (r.selector) out.selector = String(r.selector);
  if (r.attribute) out.attribute = String(r.attribute);
  if (typeof r.optional === "boolean") out.optional = r.optional;
  if (r.default !== undefined) out.default = r.default as string | number;
  if (r.case && typeof r.case === "object") out.case = r.case as Record<string, string | number>;
  if (r.remove) out.remove = String(r.remove);
  if (r.text !== undefined) out.text = r.text as string | number;
  if (Array.isArray(r.filters)) out.filters = parseFilters(r.filters);
  return out;
}

function parseFilters(arr: unknown[]): FilterBlock[] {
  return arr.map((f) => {
    const r = (f ?? {}) as Record<string, unknown>;
    return { name: asString(r.name) ?? "", args: r.args as FilterArgs | undefined };
  });
}

/** All filter names referenced by a definition (field, rows, search-level). */
function collectFilterNames(search: CardigannSearchBlock): Set<string> {
  const names = new Set<string>();
  const walkSel = (s?: SelectorBlock) => s?.filters?.forEach((f) => names.add(f.name));
  const walkSelMap = (m?: FieldsBlock) => m && Object.values(m).forEach(walkSel);
  walkSelMap(search.fields);
  if (search.rows?.filters) search.rows.filters.forEach((f) => names.add(f.name));
  search.keywordsfilters?.forEach((f) => names.add(f.name));
  search.preprocessingfilters?.forEach((f) => names.add(f.name));
  walkSel(search.rows?.count);
  walkSel(search.rows?.dateheaders);
  return names;
}

function collectUnsupportedFilters(search: CardigannSearchBlock): string[] {
  const names = [...collectFilterNames(search)];
  const unsupported = names.filter((n) => !isFilterSupported(n));
  return [...new Set(unsupported)];
}

// ---------------------------------------------------------------------------
// Settings schema + legacy `${...}` substitution (kept for back-compat callers)
// ---------------------------------------------------------------------------

export function cardigannSettingsSchema(def: CardigannDefinition): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const s of def.settings ?? []) {
    let zs: z.ZodTypeAny = z.string();
    if (s.type === "number") zs = z.coerce.number();
    else if (s.type === "checkbox") zs = z.boolean();
    else if (s.type === "info") { shape[s.name] = z.string().optional(); continue; }
    shape[s.name] = s.required && s.default === undefined ? zs : zs.optional();
  }
  return z.object(shape);
}

/** Legacy `${name}` / `${query.x}` / `${Config.x}` subst — kept for the old test surface. */
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
    return String(settings[key] ?? "");
  });
}

// ---------------------------------------------------------------------------
// Template context + filter-as-template functions
// ---------------------------------------------------------------------------

/** Filter functions made callable inside Go templates: `{{ re_replace .X "a" "b" }}`. */
function templateFuncs(): Record<string, TplFunc> {
  const out: Record<string, TplFunc> = {};
  for (const name of ["append", "prepend", "replace", "re_replace", "regexp", "split", "trim",
    "tolower", "toupper", "urldecode", "urlencode", "htmldecode", "htmlencode", "querystring",
    "validfilename", "diacritics", "validate", "dateparse", "timeparse", "timeago", "fuzzytime"]) {
    out[name] = (value, ...rest) => {
      const args: FilterArgs = rest.length <= 1 ? (rest[0] as FilterArg | undefined) : (rest as unknown as FilterArg[]);
      return applyFilter(name, String(value ?? ""), args);
    };
  }
  return out;
}

interface RenderCtx {
  Config: Record<string, unknown>;
  Keywords: string;
  Query: Record<string, unknown>;
  Categories: (string | number)[];
  Result: Record<string, unknown>;
  Today: { Year: number };
  True: boolean;
  False: boolean;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Value extraction (HTML/XML via cheerio, JSON via paths)
// ---------------------------------------------------------------------------

type Row = { kind: "dom"; $: cheerio.CheerioAPI; el: cheerio.Cheerio<any> } | { kind: "json"; obj: Record<string, unknown> };

function domText(row: Row, el: cheerio.Cheerio<any>, remove?: string): string {
  let target = el;
  if (remove) target = el.clone().find(remove).remove().end();
  return (target.text() ?? "").replace(/\s+/g, " ").trim();
}
function domAttr(el: cheerio.Cheerio<any>, attr: string): string {
  return el.attr(attr) ?? "";
}
function jsonPath(obj: unknown, path: string): unknown {
  const p = path.replace(/^\$\.?/, "").split(".").filter(Boolean);
  let cur: unknown = obj;
  for (const k of p) {
    if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[k];
    else return undefined;
  }
  return cur;
}

/** Extract a row's "search text" (used for the `andmatch` row filter). */
function rowText(row: Row): string {
  if (row.kind === "json") return JSON.stringify(row.obj).toLowerCase();
  return (row.el.text() ?? "").toLowerCase();
}

function andmatch(row: Row, keywords: string[]): boolean {
  const t = rowText(row);
  return keywords.every((kw) => kw === "" || t.includes(kw.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Field evaluator (field-ordering: each completed field → Result before the next)
// ---------------------------------------------------------------------------

class FieldEvaluator {
  constructor(
    private readonly fields: FieldsBlock,
    private readonly funcs: Record<string, TplFunc>,
  ) {}

  /**
   * Evaluate all fields for a row in declaration order, mutating `result` as it goes.
   * Returns the final field values (also present on `result`).
   */
  evaluate(row: Row, ctx: RenderCtx): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [name, sel] of Object.entries(this.fields)) {
      result[name] = this.evalSelector(sel, row, { ...ctx, Result: result });
    }
    return result;
  }

  private render(text: string, ctx: RenderCtx): string {
    return renderTemplate(text, ctx as TemplateContext, this.funcs);
  }

  private applyFilters(value: string, filters: FilterBlock[] | undefined, ctx: RenderCtx): string | number {
    let v: string | number = value;
    for (const f of filters ?? []) {
      if (!isFilterSupported(f.name)) throw new UnsupportedFilterError(f.name);
      let args: FilterArgs = f.args;
      if (Array.isArray(args)) args = args.map((a) => (typeof a === "string" ? this.render(a, ctx) : a)) as FilterArgs;
      else if (typeof args === "string") args = this.render(args, ctx);
      v = applyFilter(f.name, String(v), args);
    }
    return v;
  }

  /** Evaluate one SelectorBlock against a row. Returns the value (string, or ms for date fields handled by callers).
   *  Public so the login flow can reuse it for selectorinputs (evaluated against the whole login page DOM). */
  evalSelector(sel: SelectorBlock, row: Row, ctx: RenderCtx): string | number {
    let value: string | number = "";

    if (sel.text !== undefined) {
      // Literal or template text override.
      value = typeof sel.text === "number" ? sel.text : this.render(sel.text, ctx);
    } else if (sel.selector !== undefined || sel.attribute !== undefined || (sel.case && !sel.selector)) {
      if (row.kind === "json") {
        if (sel.selector) value = String(jsonPath(row.obj, sel.selector) ?? "");
        else value = "";
        if (sel.case) value = matchCase(sel.case, value);
      } else {
        const root = row.el;
        if (sel.case && !sel.selector && !sel.attribute) {
          // case-only selector (selectors as keys, e.g. downloadvolumefactor)
          for (const [keySel, mapVal] of Object.entries(sel.case)) {
            if (keySel === "*") continue;
            let hit = false;
            if (root.is(keySel)) hit = true;
            else if (root.find(keySel).length) hit = true;
            if (hit) { value = String(mapVal); break; }
          }
          if (value === "") value = String(sel.case["*"] ?? "");
        } else if (sel.selector) {
          const el = root.find(sel.selector).first();
          if (el.length) {
            value = sel.attribute ? domAttr(el, sel.attribute) : domText(row, el, sel.remove);
          } else if (sel.case) {
            value = String(sel.case["*"] ?? "");
          }
        } else if (sel.attribute && root.attr(sel.attribute)) {
          value = root.attr(sel.attribute) ?? "";
        }
      }
    } else if (sel.case) {
      value = matchCase(sel.case, "");
    }

    if (value === "" && sel.default !== undefined) {
      value = typeof sel.default === "number" ? sel.default : this.render(sel.default, ctx);
    }

    return this.applyFilters(String(value), sel.filters, ctx);
  }
}

function matchCase(map: Record<string, string | number>, value: string | number): string {
  const sv = String(value);
  if (sv in map) return String(map[sv]);
  // value-style keys (JSON mode: selector is a JSON path, value compared literally)
  for (const [k, v] of Object.entries(map)) {
    if (k === "*") continue;
    if (sv === k) return String(v);
  }
  return String(map["*"] ?? "");
}

// ---------------------------------------------------------------------------
// Release assembly
// ---------------------------------------------------------------------------

function num(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  const s = String(v).trim();
  const m = /([\d.,KkMmGgTt]+)/.exec(s);
  return m ? parseFloat(m[1].replace(/,/g, "")) : undefined;
}
function parseSize(v: string | number): number {
  if (typeof v === "number") return v;
  const m = /([\d.]+)\s*([KMGT]?i?B)/i.exec(v);
  if (!m) return Number(v.replace(/[^0-9.]/g, "")) || 0;
  const unit = m[2].toUpperCase();
  const mult = unit.startsWith("K") ? 1024 : unit.startsWith("M") ? 1024 ** 2 : unit.startsWith("G") ? 1024 ** 3 : unit.startsWith("T") ? 1024 ** 4 : 1;
  return Math.round(Number(m[1]) * mult);
}
function ageHours(v: unknown): number {
  if (typeof v === "number" && v > 1e10) return Math.max(0, (Date.now() - v) / 3_600_000);
  if (typeof v === "number") return 0;
  const s = String(v ?? "").trim().toLowerCase();
  if (!s || s === "now") return 0;
  return 0;
}
function parseCats(v: unknown): number[] {
  const s = String(v ?? "");
  const parts = s.split(/[,:;|]/).map((x) => x.trim()).filter(Boolean);
  return parts.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0);
}

function buildRelease(
  defName: string, key: string, protocol: "usenet" | "torrent", row: Record<string, unknown>, seed: number,
): Release | null {
  const title = String(row["title"] ?? "").trim();
  if (!title) return null;
  const details = String(row["details"] ?? "");
  const download = String(row["download"] ?? "");
  const magnet = String(row["magnet"] ?? "");
  const infohash = String(row["infohash"] ?? "");
  const seeders = num(row["seeders"]) ?? 0;
  const leechers = num(row["leechers"]) ?? 0;
  // SON-025b: a Cardigann definition MAY define downloadvolumefactor/uploadvolumefactor fields
  // (a standard Jackett/Cardigann convention). When present (string or number, per how the
  // definition's selector evaluated), parse them into the raw volume factors and derive
  // isFreeleech from the download factor. Reuse the existing `num()` parser (already used for
  // seeders/leechers here): unlike a bare Number(), it requires a digit to match, so an empty
  // string — the fallback a case-only freeleech selector produces for a row with no matching
  // case and no "*" catch-all — correctly reads as "no data" (undefined => isFreeleech false),
  // NOT as 0. When the definition has no such field at all, row[...] is undefined and both
  // raw fields stay undefined with isFreeleech false, exactly today's behavior (strictly additive).
  const downloadVolumeFactor = num(row["downloadvolumefactor"]);
  const uploadVolumeFactor = num(row["uploadvolumefactor"]);
  const id = String(row["guid"] ?? "") || infohash || download || magnet || details || `row-${seed}`;
  let downloadUrl = download || magnet || "";
  if (!downloadUrl && infohash && /^[a-fA-F0-9]{32,40}$/.test(infohash)) {
    downloadUrl = `magnet:?xt=urn:btih:${infohash.toLowerCase()}&dn=${encodeURIComponent(title)}`;
  }
  return {
    id,
    indexerId: key,
    indexerName: defName,
    title,
    protocol,
    categories: parseCats(row["category"] ?? row["categorydesc"] ?? []),
    size: parseSize(String(row["size"] ?? "0")),
    ageHours: ageHours(row["date"]),
    seeders,
    leechers,
    peers: seeders + (leechers || 0),
    downloadUrl,
    magnetUrl: magnet || downloadUrl.startsWith("magnet:") ? downloadUrl : undefined,
    infoUrl: details || linkOr(download) || undefined,
    quality: parseReleaseTitle(title).quality,
    // was hardcoded false before SON-025b — now derived from the real download factor when the
    // definition provides one, still false when it doesn't.
    downloadVolumeFactor,
    uploadVolumeFactor,
    isFreeleech: downloadVolumeFactor === 0,
    isProper: /\bproper\b/i.test(title),
    isRepack: /\brepack\b/i.test(title),
  };
}
function linkOr(url: string): string | undefined { return url || undefined; }

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Cardigann HTTP provider. `definitionText` = the YAML, `settings` = configured values
 * (validated), `proxy`/`flareSolverrUrl` routed through the fetch builder, and
 * `sessionState` = an opaque value round-tripped through the DB so a search can carry
 * session/cookie state (plain-text placeholder for now — the J9 AES-256-GCM codec is wired in
 * when the Stage 2 login engine adds the DB write path).
 */
export class CardigannProvider implements IndexerContract {
  readonly key: string;
  readonly protocol: "usenet" | "torrent";
  private readonly def: CardigannDefinition;
  private readonly login: CardigannLoginBlock | undefined;
  private readonly settings: Record<string, unknown>;
  private readonly fetcher: Fetcher;
  private readonly baseUrl: string;
  private readonly funcs: Record<string, TplFunc>;
  private readonly evaluator: FieldEvaluator;
  private jar: CookieJar;
  private storedSession: string | undefined;

  constructor(opts: {
    key: string;
    protocol: "usenet" | "torrent";
    definitionText: string;
    settings: Record<string, unknown>;
    fetcher?: Fetcher;
    sessionState?: string;
  }) {
    this.key = opts.key;
    this.protocol = opts.protocol;
    this.def = parseCardigannYaml(opts.definitionText);
    this.login = this.def.login;
    this.settings = opts.settings;
    this.fetcher = opts.fetcher ?? fetch;
    this.baseUrl = String(this.settings["baseUrl"] ?? "").replace(/\/$/, "");
    this.funcs = templateFuncs();
    this.evaluator = new FieldEvaluator(this.def.search.fields ?? {}, this.funcs);
    this.storedSession = opts.sessionState;
    this.jar = CookieJar.fromSerialized(opts.sessionState);
  }

  get definitionName(): string { return this.def.name; }

  /** Raw serialized session (cookie jar JSON). Exposed so the API layer can persist it encrypted. */
  get session(): string | undefined { return this.login ? this.sessionValue() : undefined; }

  /** Session/cookie state accessor — lets a search carry it in and out (DB round-trip). */
  get sessionState(): string | undefined { return this.sessionValue(); }
  setSessionState(v: string | undefined): void { this.storedSession = v; this.jar = CookieJar.fromSerialized(v); }

  private sessionValue(): string | undefined { return this.storedSession; }

  private ctx(query: string, categories?: number[]): RenderCtx {
    return {
      Config: this.settings,
      Keywords: query,
      Query: { Type: "search", Season: undefined, Ep: undefined, IMDBID: undefined, TMDBID: undefined },
      Categories: (categories ?? []).map(String),
      Result: {},
      Today: { Year: new Date().getFullYear() },
      True: true,
      False: false,
    };
  }

  async search(params: SearchParams): Promise<Release[]> {
    if (!params.query) return [];
    // Flag (never silently mis-execute) definitions that use a filter we can't run.
    if (this.def.unsupportedFilters.length) {
      throw new UnsupportedFilterError(this.def.unsupportedFilters.join(", "));
    }
    // Stage 2: ensure a valid session before searching when the definition requires login.
    if (this.login?.method) await this.ensureLoggedIn();
    const releases: Release[] = [];
    for (const p of (this.def.search.paths ?? [])) {
      releases.push(...await this.searchPath(p, params));
    }
    return releases;
  }

  private async searchPath(p: CardigannSearchPath, params: SearchParams): Promise<Release[]> {
    const ctx = this.ctx(params.query ?? "", params.categories);
    const renderedPath = renderTemplate(p.path, ctx as TemplateContext, this.funcs);
    const inputs = this.effectiveInputs(p, ctx);
    const headers: Record<string, string> = {};
    for (const [k, vals] of Object.entries(this.def.search.headers ?? {})) {
      headers[k] = vals.map((v) => renderTemplate(v, ctx as TemplateContext, this.funcs)).join(", ");
    }
    const resp = await this.http(renderedPath, { method: p.method, inputs, headers, queryseparator: p.queryseparator, ctx });
    const body = await resp.text();
    const mode = p.response?.type ?? "html";
    return this.parseResponse(mode, body, ctx);
  }

  /**
   * Central HTTP helper used by both search and the login flow. It joins a (already-rendered)
   * path to the tracker base (or uses it verbatim when absolute), attaches the cookie jar as a
   * `Cookie` header, sends a GET (query params) or POST (form body), and absorbs any
   * `Set-Cookie` from the response into the jar. This is what makes sessions persist across
   * the DB round-trip.
   */
  private async http(
    renderedPath: string,
    opts: { method?: "get" | "post"; inputs?: Record<string, string>; headers?: Record<string, string>; queryseparator?: string; ctx?: RenderCtx; followRedirect?: boolean } = {},
  ): Promise<Response> {
    const ctx = opts.ctx ?? this.ctx("");
    const base = this.baseUrl.includes("://") ? this.baseUrl : `https://${this.baseUrl}`;
    let url = /^https?:\/\//i.test(renderedPath)
      ? renderedPath
      : `${base}${renderedPath.startsWith("/") ? "" : "/"}${renderedPath}`;
    const method = opts.method ?? "get";
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    const cookieHeader = this.jar.toCookieHeader();
    if (cookieHeader) headers["cookie"] = cookieHeader;
    // Login requests must NOT follow redirects: undici drops the intermediate response's
    // Set-Cookie when it follows a 3xx, and login sessions are exactly the cookies set on that
    // redirect (e.g. POST /login → 302 with a session cookie).
    const redirect = opts.followRedirect === false ? ("manual" as const) : ("follow" as const);

    let resp: Response;
    if (method === "post") {
      const body = this.buildQuery(opts.inputs ?? {}, opts.queryseparator);
      headers["content-type"] = headers["content-type"] ?? "application/x-www-form-urlencoded";
      resp = await this.fetcher(url, { method: "POST", headers, body: body || undefined, redirect });
    } else {
      const qs = this.buildQuery(opts.inputs ?? {}, opts.queryseparator);
      if (qs) url += (url.includes("?") ? "&" : "?") + qs;
      resp = await this.fetcher(url, { method: "GET", headers, redirect });
    }
    this.jar.absorbResponse(resp);
    void ctx;
    return resp;
  }

  // ---------------------------------------------------------------------------
  // Stage 2 login engine
  // ---------------------------------------------------------------------------

  /** Ensure a valid session exists (re-login when expired/missing) for definitions that require it. */
  private async ensureLoggedIn(): Promise<void> {
    const L = this.login!;
    if (L.test) {
      // Authoritative check: if a restored session already passes, reuse it.
      if (this.jar.hasCookies() && await this.loginTestPasses(L)) return;
    } else if (this.jar.hasCookies()) {
      // No test block — trust the restored cookies.
      return;
    }
    await this.performLogin(L);
  }

  private async performLogin(L: CardigannLoginBlock): Promise<void> {
    const ctx = this.ctx("");
    const headers: Record<string, string> = {};
    for (const [k, vals] of Object.entries(L.headers ?? {})) {
      headers[k] = vals.map((v) => renderTemplate(v, ctx as TemplateContext, this.funcs)).join(", ");
    }
    const inputs = this.renderedLoginInputs(L.inputs, ctx);

    switch (L.method) {
      case "cookie": {
        const cookieVal = inputs["cookie"] ?? inputs[Object.keys(inputs)[0]] ?? "";
        this.jar = new CookieJar();
        this.jar.parseCookieString(cookieVal);
        break;
      }
      case "oneurl": {
        await this.http(renderTemplate(L.path ?? "/", ctx as TemplateContext, this.funcs), { method: "get", ctx, followRedirect: false });
        break;
      }
      case "get": {
        const resp = await this.http(renderTemplate(L.path ?? "/", ctx as TemplateContext, this.funcs), { method: "get", inputs, headers, ctx, followRedirect: false });
        const body = await resp.text();
        this.checkLoginErrorOnBody(body, L);
        break;
      }
      case "post": {
        const resp = await this.http(renderTemplate(L.path ?? "/", ctx as TemplateContext, this.funcs), { method: "post", inputs, headers, ctx, followRedirect: false });
        const body = await resp.text();
        this.checkLoginErrorOnBody(body, L);
        break;
      }
      case "form": {
        const pageResp = await this.http(renderTemplate(L.path ?? "/", ctx as TemplateContext, this.funcs), { method: "get", headers, ctx, followRedirect: false });
        const html = await pageResp.text();
        const $ = cheerio.load(html);
        const merged = { ...inputs };
        const pageRow: Row = { kind: "dom", $, el: $("html").first() };
        for (const [k, sel] of Object.entries(L.selectorinputs ?? {})) {
          const v = this.evaluator.evalSelector(sel, pageRow, ctx);
          if (v !== undefined && String(v) !== "") merged[k] = String(v);
        }
        if (L.selectors) {
          $("form input[type='hidden']").each((_i, el) => {
            const n = $(el).attr("name");
            const v = $(el).attr("value");
            if (n) merged[n] = v ?? "";
          });
        }
        const submit = L.submitpath ?? this.resolveFormAction($, L.form) ?? L.path ?? "/";
        const resp = await this.http(renderTemplate(submit, ctx as TemplateContext, this.funcs), { method: "post", inputs: merged, headers, ctx, followRedirect: false });
        const body = await resp.text();
        this.checkLoginErrorOnBody(body, L);
        break;
      }
      default:
        return;
    }

    if (L.test) {
      if (!await this.loginTestPasses(L)) {
        throw new Error(`Cardigann login failed: test selector "${L.test.selector ?? L.test.path}" not found`);
      }
    }
    // Persist the (raw) session so the API layer can encrypt it into indexer.sessionState.
    this.storedSession = this.jar.serialize();
  }

  private renderedLoginInputs(inputs: Record<string, string | number | boolean> | undefined, ctx: RenderCtx): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(inputs ?? {})) {
      out[k] = renderTemplate(String(v), ctx as TemplateContext, this.funcs);
    }
    return out;
  }

  private async loginTestPasses(L: CardigannLoginBlock): Promise<boolean> {
    const ctx = this.ctx("");
    const resp = await this.http(renderTemplate(L.test?.path ?? "/", ctx as TemplateContext, this.funcs), { method: "get", ctx });
    const html = await resp.text();
    if (!L.test?.selector) return true;
    const $ = cheerio.load(html);
    return $(L.test.selector).length > 0;
  }

  private resolveFormAction($: cheerio.CheerioAPI, formSel?: string): string | undefined {
    if (formSel) {
      const el = $(formSel).first();
      if (el.length) {
        const action = el.attr("action");
        if (action) return action;
      }
    }
    return undefined;
  }

  private checkLoginErrorOnBody(body: string, L: CardigannLoginBlock): void {
    if (!L.error?.length) return;
    const $ = cheerio.load(body);
    const html = $("html").first();
    for (const e of L.error) {
      if (!e.selector) continue;
      if ($(e.selector).length) {
        let msg = "";
        if (e.message) msg = String(this.evaluator.evalSelector(e.message as SelectorBlock, { kind: "dom", $, el: html }, this.ctx("")));
        throw new Error(`Cardigann login failed${msg ? `: ${msg}` : ""}`);
      }
    }
  }

  private effectiveInputs(p: CardigannSearchPath, ctx: RenderCtx): Record<string, string> {
    const merged: Record<string, unknown> = { ...(this.def.search.inputs ?? {}) };
    if (p.inheritinputs !== false) Object.assign(merged, p.inputs ?? {});
    else if (p.inputs) Object.assign(merged, p.inputs);
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(merged)) {
      out[k] = renderTemplate(String(v), ctx as TemplateContext, this.funcs);
    }
    return out;
  }

  private buildQuery(inputs: Record<string, string>, queryseparator?: string): string {
    const sep = queryseparator ?? "&";
    const parts: string[] = [];
    for (const [k, v] of Object.entries(inputs)) {
      if (k === "$raw") { if (v) parts.push(v); continue; }
      if (k.startsWith("$")) continue;
      if (v === "" && !this.def.search.allowEmptyInputs) continue;
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    }
    return parts.join(sep);
  }

  private parseResponse(mode: "html" | "json" | "xml", body: string, ctx: RenderCtx): Release[] {
    const fields = this.def.search.fields ?? {};
    const evaluator = new FieldEvaluator(fields, this.funcs);
    const releases: Release[] = [];

    if (mode === "json") {
      let data: unknown;
      try { data = JSON.parse(body); } catch { return []; }
      const rows = this.jsonRows(data, ctx);
      let seed = 0;
      for (const obj of rows) {
        const row: Row = { kind: "json", obj };
        if (!this.rowKept(row, ctx)) continue;
        const vals = evaluator.evaluate(row, ctx);
        const rel = buildRelease(this.def.name, this.key, this.protocol, vals, seed++);
        if (rel) releases.push(rel);
      }
      return releases;
    }

    const xml = mode === "xml";
    const $ = cheerio.load(body, xml ? { xmlMode: true } : undefined);
    const rows = this.domRows($, ctx);
    let seed = 0;
    for (const el of rows) {
      const row: Row = { kind: "dom", $, el };
      if (!this.rowKept(row, ctx)) continue;
      const vals = evaluator.evaluate(row, ctx);
      const rel = buildRelease(this.def.name, this.key, this.protocol, vals, seed++);
      if (rel) releases.push(rel);
    }
    return releases;
  }

  private jsonRows(data: unknown, ctx: RenderCtx): Record<string, unknown>[] {
    const rowsBlock = this.def.search.rows;
    if (!rowsBlock) return [];
    let selected: unknown[];
    if (rowsBlock.selector) {
      // JSON path (dot) selector; may contain templates (rare)
      const sel = renderTemplate(rowsBlock.selector, ctx as TemplateContext, this.funcs);
      const v = jsonPath(data, sel);
      selected = Array.isArray(v) ? v : [];
    } else {
      selected = Array.isArray(data) ? data : [];
    }
    const out: Record<string, unknown>[] = [];
    for (const s of selected) {
      if (!s || typeof s !== "object") continue;
      const obj = s as Record<string, unknown>;
      if (rowsBlock.attribute) {
        const sub = obj[rowsBlock.attribute];
        if (Array.isArray(sub)) out.push(...sub.map((x) => (x && typeof x === "object" ? x as Record<string, unknown> : {})));
      } else {
        out.push(obj);
      }
    }
    return out;
  }

  private domRows($: cheerio.CheerioAPI, ctx: RenderCtx): cheerio.Cheerio<any>[] {
    const rowsBlock = this.def.search.rows;
    if (!rowsBlock?.selector) return [];
    const sel = renderTemplate(rowsBlock.selector, ctx as TemplateContext, this.funcs);
    const out: cheerio.Cheerio<any>[] = [];
    $(sel).each((_i, el) => { out.push($(el)); });
    return out;
  }

  /** Apply row-level filters (andmatch drops rows whose text lacks all query keywords). */
  private rowKept(row: Row, ctx: RenderCtx): boolean {
    const rf = this.def.search.rows?.filters;
    if (!rf) return true;
    const keywords = ctx.Keywords.trim() ? ctx.Keywords.trim().split(/\s+/) : ["__any__"];
    for (const f of rf) {
      if (f.name === "andmatch" && !andmatch(row, keywords)) return false;
      // strdump (debug) is discarded.
    }
    return true;
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
}

function asString(v: unknown): string | undefined {
  return v == null ? undefined : String(v);
}

// ---------------------------------------------------------------------------
// Definition support status (roadmap D4, Stage 3 sync job)
// ---------------------------------------------------------------------------

/** Template functions the interpreter can execute (builtins + the filter pipeline). */
export const KNOWN_TEMPLATE_FUNCTIONS: ReadonlySet<string> = new Set([
  "eq", "ne", "and", "or", "join",
  "append", "prepend", "replace", "re_replace", "regexp", "split", "trim", "tolower", "toupper",
  "urldecode", "urlencode", "htmldecode", "htmlencode", "querystring", "validfilename", "diacritics",
  "validate", "dateparse", "timeparse", "timeago", "fuzzytime",
]);

export interface CardigannStatus {
  supported: boolean;
  /** Human-readable reasons when unsupported (empty when supported). */
  reasons: string[];
}

/** Every template string in a definition (fields, search paths/inputs, login blocks, …). */
function collectTemplateStrings(def: CardigannDefinition): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (v: unknown): void => {
    if (v === null || v === undefined) return;
    if (typeof v === "string") {
      if (v.includes("{{") && !seen.has(v)) { seen.add(v); out.push(v); }
      return;
    }
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (typeof v === "object") { for (const k of Object.values(v as Record<string, unknown>)) walk(k); }
  };
  walk(def);
  return out;
}

/** Template functions a definition calls that this interpreter does not implement. */
export function cardigannUnknownTemplateFunctions(def: CardigannDefinition): string[] {
  const unknown = new Set<string>();
  for (const s of collectTemplateStrings(def)) {
    const { functions, error } = templateFunctionNames(s);
    if (error) { unknown.add("malformed template"); continue; }
    for (const f of functions) if (!KNOWN_TEMPLATE_FUNCTIONS.has(f)) unknown.add(f);
  }
  return [...unknown];
}

/**
 * Whether a parsed definition can actually be executed by this interpreter. The sync job tags
 * every upstream definition supported/unsupported with these reasons so broken indexers are
 * never silently exposed as usable.
 */
export function cardigannDefinitionStatus(def: CardigannDefinition): CardigannStatus {
  const reasons: string[] = [];
  if (def.unsupportedFilters.length) reasons.push(`unsupported filters: ${def.unsupportedFilters.join(", ")}`);
  if (def.login?.captcha) reasons.push("captcha (unsupported)");
  const unknownTpl = cardigannUnknownTemplateFunctions(def);
  if (unknownTpl.length) reasons.push(`unsupported template functions: ${unknownTpl.join(", ")}`);
  return { supported: reasons.length === 0, reasons };
}

export { YAML, z, UnsupportedFilterError, applyFilter, renderTemplate, CompiledTemplate };
