// SPDX-License-Identifier: MIT
/**
 * Minimal cookie jar for the Cardigann login engine (roadmap D4, Stage 2).
 *
 * Cardigann trackers authenticate via HTTP cookies. The provider has no in-memory cache
 * between searches (indexers are rebuilt from the DB each call, unlike download clients),
 * so the jar's contents must serialize into `indexer.sessionState` and round-trip through
 * the DB. A jar is a list of {name, value} pairs (attributed to a single indexer origin) —
 * enough for the `cookie`/`form`/`post`/`get`/`oneurl` login methods and for issuing a
 * `Cookie` request header.
 */
export interface CookiePair {
  name: string;
  value: string;
}

export class NoCookiesError extends Error {
  constructor() {
    super("no cookies in session");
    this.name = "NoCookiesError";
  }
}

export class CookieJar {
  private cookies: CookiePair[] = [];

  /** Restore from a serialized (JSON) session string produced by {@link serialize}. */
  static fromSerialized(serialized: string | undefined): CookieJar {
    const jar = new CookieJar();
    if (!serialized) return jar;
    try {
      const parsed = JSON.parse(serialized) as unknown;
      if (Array.isArray(parsed)) {
        jar.cookies = parsed
          .filter((c): c is CookiePair => !!c && typeof (c as CookiePair).name === "string" && typeof (c as CookiePair).value === "string")
          .map((c) => ({ name: (c as CookiePair).name, value: (c as CookiePair).value }));
      }
    } catch {
      // ignore malformed persisted session; treat as empty
    }
    return jar;
  }

  get size(): number {
    return this.cookies.length;
  }

  hasCookies(): boolean {
    return this.cookies.length > 0;
  }

  /** Set/replace one cookie by name. */
  set(name: string, value: string): void {
    const existing = this.cookies.find((c) => c.name === name);
    if (existing) existing.value = value;
    else this.cookies.push({ name, value });
  }

  /** Parse a `name=value; name2=value2; ...` cookie string (e.g. a user-supplied session cookie). */
  parseCookieString(cookieString: string): void {
    for (const part of cookieString.split(";")) {
      const idx = part.indexOf("=");
      if (idx === -1) continue;
      const name = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (name) this.set(name, value);
    }
  }

  /** Absorb `Set-Cookie` headers from an HTTP response (node may return one value or an array). */
  absorbResponse(resp: Response): void {
    const headers = resp.headers;
    let values: string[] = [];
    if (typeof headers.getSetCookie === "function") {
      try { values = headers.getSetCookie(); } catch { /* noop */ }
    }
    if (values.length === 0) {
      const v = headers.get("set-cookie");
      if (v) values = splitSetCookie(v);
    }
    for (const sc of values) this.absorbSetCookie(sc);
  }

  private absorbSetCookie(setCookie: string): void {
    const semi = setCookie.indexOf(";");
    const pair = (semi === -1 ? setCookie : setCookie.slice(0, semi)).trim();
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    // ignore deletion cookies (empty value with a Max-Age=0/Expires in the past)
    if (value === "" && /max-age=0|expires=.*?1970/i.test(setCookie)) {
      this.delete(name);
      return;
    }
    if (name.startsWith("__Secure-") && !/secure/i.test(setCookie)) return;
    this.set(name, value);
  }

  delete(name: string): void {
    this.cookies = this.cookies.filter((c) => c.name !== name);
  }

  /** `Cookie` request header value ("name=value; name2=value2") or undefined if empty. */
  toCookieHeader(): string | undefined {
    if (this.cookies.length === 0) return undefined;
    return this.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  }

  /** Serialize to a stable JSON string for persistence (the raw `sessionState` value). */
  serialize(): string {
    return JSON.stringify(this.cookies);
  }
}

/** Split a Set-Cookie header that may contain multiple same-key values joined by the spec's ", ". */
function splitSetCookie(v: string): string[] {
  // A robust split is hard; handle the common node join case by splitting on ', ' between cookies
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < v.length; i++) {
    const ch = v[i];
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === "," && !inQuotes) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
