// SPDX-License-Identifier: MIT
import type { Request } from "express";

// Hand-rolled rather than pulling in the `cookie` package: we only ever handle one
// cookie name/value pair, and the `cookie` package's v2 type exports need a
// moduleResolution setting ("bundler"/"node16") this project doesn't use elsewhere —
// not worth changing tsconfig resolution mode project-wide for this.
export const SESSION_COOKIE_NAME = "mn_session";
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days, matches signSession's expiry

function serializeCookie(name: string, value: string, maxAgeSeconds: number): string {
  const attrs = [`${name}=${encodeURIComponent(value)}`, "Path=/", `Max-Age=${maxAgeSeconds}`, "HttpOnly", "SameSite=Strict"];
  return attrs.join("; ");
}

/** Builds the Set-Cookie header value for a freshly-issued session. */
export function buildSessionCookie(value: string): string {
  return serializeCookie(SESSION_COOKIE_NAME, value, SESSION_MAX_AGE_SECONDS);
}

/** Builds the Set-Cookie header value that clears the session cookie (logout). */
export function clearSessionCookie(): string {
  return serializeCookie(SESSION_COOKIE_NAME, "", 0);
}

/** Reads the raw session cookie value from an incoming request, if present. */
export function readSessionCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const pair of header.split(";")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const name = pair.slice(0, idx).trim();
    if (name !== SESSION_COOKIE_NAME) continue;
    try {
      return decodeURIComponent(pair.slice(idx + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}
