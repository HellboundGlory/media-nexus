// SPDX-License-Identifier: MIT
/**
 * Cardigann FilterBlock pipeline (D4 Stage 1).
 *
 * Implements the filter functions actually used by the 542-def corpus, ordered by
 * frequency (see RESEARCH/CARDIGANN_V11_SPEC.md). Unimplemented schema-listed filters are
 * never silently mis-executed — they throw {@link UnsupportedFilterError}, which a caller
 * surfaces as validation-time "unsupported" (the plan's rule).
 *
 * Filters that turn a value into a *time* (dateparse/timeparse/timeago/reltime/fuzzytime)
 * return epoch milliseconds; the rest return a string. Row-level filters (andmatch/strdump)
 * are handled by the provider, not here.
 */
export type FilterArg = string | number | boolean;
export type FilterArgs = FilterArg | FilterArg[] | undefined;

export class UnsupportedFilterError extends Error {
  constructor(name: string) {
    super(`Cardigann filter "${name}" is not supported by this interpreter`);
    this.name = "UnsupportedFilterError";
  }
}

/** Normalize flexible `args` (string | int | array) into an array of leaves. */
function argList(args: FilterArgs): FilterArg[] {
  if (args === undefined) return [];
  return Array.isArray(args) ? args : [args];
}
function a(args: FilterArgs, i: number): string {
  const v = argList(args)[i];
  return v === undefined ? "" : String(v);
}

/** Filters the value pipeline applies (excluding row filters, which live in the provider). */
export const VALUE_FILTER_NAMES = [
  "querystring", "timeparse", "dateparse", "regexp", "re_replace", "split", "replace",
  "trim", "prepend", "append", "tolower", "toupper", "urldecode", "urlencode",
  "htmldecode", "htmlencode", "timeago", "reltime", "fuzzytime", "validfilename",
  "diacritics", "jsonjoinarray", "hexdump", "strdump", "validate",
] as const;
export type ValueFilterName = (typeof VALUE_FILTER_NAMES)[number];

const UNSUPPORTED = new Set<string>(["reltime", "strdump", "jsonjoinarray", "hexdump"]);

/** Whether this filter is implemented (vs. flagged unsupported). */
export function isFilterSupported(name: string): boolean {
  if (UNSUPPORTED.has(name)) return false;
  return (VALUE_FILTER_NAMES as readonly string[]).includes(name) || ["andmatch", "strdump"].includes(name);
}

/**
 * Apply one filter to a string value. `args` is the FilterBlock.args.
 * Returns a string, or epoch milliseconds for the time-producing filters.
 */
export function applyFilter(name: string, value: string, args?: FilterArgs): string | number {
  switch (name) {
    case "append": return value + a(args, 0);
    case "prepend": return a(args, 0) + value;
    case "replace": { const [from, to] = argList(args); return from === undefined ? value : value.split(String(from)).join(String(to ?? "")); }
    case "re_replace": {
      const [pattern, replacement] = argList(args);
      if (pattern === undefined) return value;
      const { source, flags } = translateGoRegex(String(pattern));
      try { return value.replace(new RegExp(source, flags + "g"), String(replacement ?? "")); } catch { return value; }
    }
    case "regexp": {
      const [pattern] = argList(args);
      if (pattern === undefined) return value;
      const { source, flags } = translateGoRegex(String(pattern));
      try {
        const m = new RegExp(source, flags).exec(value);
        if (!m) return "";
        return m.length > 1 && m[1] !== undefined ? m[1] : m[0];
      } catch { return ""; }
    }
    case "split": {
      const [sep, idx] = argList(args);
      const parts = value.split(String(sep ?? ""));
      const i = typeof idx === "number" ? idx : parseInt(String(idx ?? "0"), 10);
      return i >= 0 && i < parts.length ? parts[i] : "";
    }
    case "trim": return value.trim();
    case "tolower": return value.toLowerCase();
    case "toupper": return value.toUpperCase();
    case "urldecode": return safeDecodeURI(value);
    case "urlencode": return encodeURIComponent(value);
    case "htmldecode": return htmlDecode(value);
    case "htmlencode": return htmlEncode(value);
    case "querystring": {
      const key = a(args, 0);
      const qs = value.includes("?") ? value.slice(value.indexOf("?") + 1) : value;
      if (!key) return value;
      const params = new URLSearchParams(qs);
      return params.get(key) ?? "";
    }
    case "validfilename": return sanitizeFilename(value);
    case "diacritics": return stripDiacritics(value);
    case "validate": return validateFilter(value, argList(args));
    // time-producing filters
    case "dateparse": {
      const fmt = a(args, 0) || "yyyy-MM-dd HH:mm:ss";
      const t = parseCardigannDate(value, fmt);
      return t === null ? value : t;
    }
    case "timeparse": {
      const fmt = a(args, 0) || "yyyy-MM-dd HH:mm:ss";
      const t = parseCardigannDate(value, fmt);
      return t === null ? value : t;
    }
    case "timeago": {
      const t = parseRelativeAgo(value);
      return t === null ? value : t;
    }
    case "fuzzytime": {
      const t = parseFuzzyTime(value);
      return t === null ? value : t;
    }
    default:
      throw new UnsupportedFilterError(name);
  }
}

// ---------- unicode / percent / html helpers ----------

function safeDecodeURI(s: string): string {
  try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { return s; }
}

const HTML_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®",
  hellip: "…", mdash: "—", ndash: "–", lsaquo: "‹", rsaquo: "›", laquo: "«", raquo: "»",
};
function htmlDecode(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return HTML_ENTITIES[e.toLowerCase()] ?? m;
  });
}
function htmlEncode(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function sanitizeFilename(s: string): string {
  return Array.from(s)
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      if (code < 0x20 || /[<>:"/\\|?*]/.test(ch)) return "_";
      if (/\s/.test(ch)) return " ";
      return ch;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/** `validate` drops the value when it doesn't satisfy the constraint (empty stays empty). */
function validateFilter(value: string, args: FilterArg[]): string {
  for (const arg of args) {
    const s = String(arg);
    if (s.startsWith("/") || /[\\^$*+?()[\]{}|.]/.test(s.replace(/\\./g, ""))) {
      try { if (!new RegExp(s).test(value)) return ""; } catch { /* ignore */ }
    } else if (value.trim() === "") {
      return "";
    }
  }
  return value;
}

// ---------- Go-regex -> JS translation ----------

/**
 * Translate the Go regexp subset actually used in defs to a JS regex source + flags:
 *  - `(?i)` inline flag -> `i` flag
 *  - `\p{Is<Script>}` (Go) -> `\p{Script=<Script>}` (JS, needs `u`)
 *  - everything else passes through; enabled by construction by the caller with `g` for re_replace.
 */
export function translateGoRegex(pattern: string): { source: string; flags: string } {
  let src = pattern;
  let flags = "";
  if (/\(\?i\)/.test(src)) { src = src.replace(/\(\?i\)/g, ""); flags += "i"; }
  src = src.replace(/\\p\{Is([A-Za-z]+)\}/g, (_m, script: string) => `\\p{Script=${script}}`);
  if (/\\p\{/.test(src)) flags += "u";
  return { source: src, flags };
}

// ---------- Cardigann date parsing ----------

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTHS_ABBR = MONTHS.map((m) => m.slice(0, 3));

interface FmtToken { key: string; }
/**
 * Tokenize a Cardigann date layout into tokens by greedily matching known multi-char keys.
 * Tokens: yyyy yy MMMM MMM MM dd dd d HH hh mm ss zzz tt aa dddd ddd SSS.
 */
function tokenizeFormat(format: string): FmtToken[] {
  const toks: FmtToken[] = [];
  const keys = ["yyyy", "MMMM", "MMM", "dddd", "ddd", "zzz", "yy", "MM", "dd", "HH", "hh", "mm", "ss", "tt", "aa", "d", "SSS"];
  let i = 0;
  while (i < format.length) {
    let matched = false;
    for (const key of keys) {
      if (format.startsWith(key, i)) { toks.push({ key }); i += key.length; matched = true; break; }
    }
    if (!matched) { toks.push({ key: format[i] }); i++; }
  }
  return toks;
}

/** Build a JS RegExp from a Cardigann date layout; groups correspond to value tokens. */
function layoutRegex(toks: FmtToken[]): { re: RegExp; groups: FmtToken[] } {
  let src = "^";
  const groups: FmtToken[] = [];
  for (const t of toks) {
    switch (t.key) {
      case "yyyy": src += "(\\d{4})"; groups.push(t); break;
      case "yy": src += "(\\d{2})"; groups.push(t); break;
      case "MMMM": src += "([A-Za-z]+)"; groups.push(t); break;
      case "MMM": src += "([A-Za-z]+)"; groups.push(t); break;
      case "MM": src += "(\\d{1,2})"; groups.push(t); break;
      case "dddd": case "ddd": src += "([A-Za-z]+)"; groups.push(t); break;
      case "dd": case "d": src += "(\\d{1,2})"; groups.push(t); break;
      case "HH": case "hh": src += "(\\d{1,2})"; groups.push(t); break;
      case "mm": src += "(\\d{1,2})"; groups.push(t); break;
      case "ss": src += "(\\d{1,2})"; groups.push(t); break;
      case "zzz": src += "([+-]\\d{2}:?\\d{2})"; groups.push(t); break;
      case "tt": case "aa": src += "([APap][Mm])"; groups.push(t); break;
      default: src += escapeRe(t.key);
    }
  }
  src += "$";
  return { re: new RegExp(src), groups };
}
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Parse `value` against a Cardigann date layout → epoch ms, or null on failure. */
export function parseCardigannDate(value: string, format: string): number | null {
  const toks = tokenizeFormat(format);
  const { re, groups } = layoutRegex(toks);
  const m = re.exec(value.trim());
  if (!m) return null;
  let year = 1970, month = 1, day = 1, h = 0, min = 0, sec = 0;
  const ms = 0;
  let tzOffset: number | null = null;
  let isPm: boolean | null = null;
  let hour12 = false;
  groups.forEach((g, idx) => {
    const v = m[idx + 1];
    switch (g.key) {
      case "yyyy": year = parseInt(v, 10); break;
      case "yy": year = 2000 + parseInt(v, 10); break;
      case "MMMM": month = MONTHS.indexOf(v.toLowerCase()) + 1; break;
      case "MMM": month = MONTHS_ABBR.indexOf(v.toLowerCase()) + 1; break;
      case "MM": month = parseInt(v, 10); break;
      case "dd": case "d": day = parseInt(v, 10); break;
      case "dddd": case "ddd": break;
      case "HH": h = parseInt(v, 10); break;
      case "hh": h = parseInt(v, 10); hour12 = true; break;
      case "mm": min = parseInt(v, 10); break;
      case "ss": sec = parseInt(v, 10); break;
      case "zzz": {
        const s = v.replace(":", "");
        const sign = s[0] === "-" ? -1 : 1;
        const hh = parseInt(s.slice(1, 3), 10), mm2 = parseInt(s.slice(3, 5), 10) || 0;
        tzOffset = sign * (hh * 60 + mm2);
        break;
      }
      case "tt": case "aa": isPm = /p/i.test(v); break;
    }
  });
  if (month === 0 || year === 1970) return null;
  if (isPm === true && !hour12) { /* noop */ }
  if (hour12) { if (h === 12 && isPm === false) h = 0; else if (h < 12 && isPm === true) h += 12; }
  // Build a UTC timestamp directly, applying the tz offset if provided (Cardigann treats
  // zzz as an absolute offset); otherwise treat as UTC to stay deterministic.
  let ts = Date.UTC(year, month - 1, day, h, min, sec, ms);
  if (tzOffset !== null) ts -= tzOffset * 60_000;
  return ts;
}

const UNIT_MS: Record<string, number> = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
  w: 7 * 86_400_000, week: 7 * 86_400_000, weeks: 7 * 86_400_000,
  month: 30 * 86_400_000, months: 30 * 86_400_000,
  y: 365 * 86_400_000, year: 365 * 86_400_000, years: 365 * 86_400_000,
};
function unitMs(u: string): number | undefined {
  const k = u.replace(/\.$/, "").toLowerCase().replace(/\s+/g, "");
  return UNIT_MS[k];
}

/** Parse "X <unit> ago" / "X<unit>" style relative times → epoch ms, else null. */
export function parseRelativeAgo(value: string): number | null {
  const s = value.trim().toLowerCase();
  const re = /^(\d+(?:[.,]\d+)?)\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?|months?|months|years?|year)\s*(ago)?$/;
  const m = re.exec(s);
  if (m) {
    const mult = unitMs(m[2]);
    if (mult === undefined) return null;
    return Date.now() - Math.round(parseFloat(m[1]) * mult);
  }
  // "today 12:25am", "yesterday 3:00pm", bare "HH:MMam/pm"
  const today = /^today\s+(\d{1,2}):(\d{1,2})\s*(am|pm)?$/.exec(s);
  if (today) return mergeTime(Date.now(), today[1], today[2], today[3]);
  const yest = /^yesterday\s+(\d{1,2}):(\d{1,2})\s*(am|pm)?$/.exec(s);
  if (yest) return mergeTime(Date.now() - 86_400_000, yest[1], yest[2], yest[3]);
  const hm = /^(\d{1,2}):(\d{1,2})\s*(am|pm)?$/.exec(s);
  if (hm) return mergeTime(Date.now(), hm[1], hm[2], hm[3]);
  return null;
}
function mergeTime(baseMs: number, hh: string, mm: string, ap: string | undefined): number {
  let h = parseInt(hh, 10);
  if (/p/i.test(ap ?? "") && h < 12) h += 12;
  if (/a/i.test(ap ?? "") && h === 12) h = 0;
  const d = new Date(baseMs);
  d.setHours(h, parseInt(mm, 10) || 0, 0, 0);
  return d.getTime();
}

/** Fuzzy relative-time parser (Cardigann `fuzzytime`) — handles common tracker formats. */
export function parseFuzzyTime(value: string): number | null {
  // relative ago already handled
  const ago = parseRelativeAgo(value);
  if (ago !== null && /ago/.test(value)) return ago;
  // "Apr. 18th '11" / "7am Sep. 14th" / "Sep. 14, 2024" (without a year → current year)
  const withYear = /^([A-Za-z]{3,9})[.]?\s+(\d{1,2})(?:st|nd|rd|th)?[.,]?\s+(?:'(\d{2})|(\d{4}))?$/i.exec(value.trim());
  if (withYear) {
    let mon = MONTHS.findIndex((x) => x.startsWith(withYear[1].toLowerCase())) + 1;
    if (mon === 0) mon = MONTHS_ABBR.indexOf(withYear[1].toLowerCase()) + 1;
    let year = new Date().getFullYear();
    if (withYear[4]) year = parseInt(withYear[4], 10);
    else if (withYear[3]) year = 2000 + parseInt(withYear[3], 10);
    return Date.UTC(year, Math.max(mon, 1) - 1, parseInt(withYear[2], 10));
  }
  const noYear = /^([A-Za-z]{3,9})[.]?\s+(\d{1,2})(?:st|nd|rd|th)?$/i.exec(value.trim());
  if (noYear) {
    const mon = MONTHS.findIndex((x) => x.startsWith(noYear[1].toLowerCase())) + 1 || MONTHS_ABBR.indexOf(noYear[1].toLowerCase()) + 1;
    return Date.UTC(new Date().getFullYear(), Math.max(mon, 1) - 1, parseInt(noYear[2], 10));
  }
  const hm = /^(\d{1,2}):(\d{1,2})\s*(am|pm)?$/i.exec(value.trim());
  if (hm) return mergeTime(Date.now(), hm[1], hm[2], hm[3]);
  if (value.trim().toLowerCase() === "now") return Date.now();
  return null;
}
