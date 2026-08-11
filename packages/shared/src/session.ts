// SPDX-License-Identifier: MIT
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface SessionPayload {
  /** passwordVersion at issue time — bumping it on password change invalidates existing sessions. */
  pv: number;
  iat: number;
  exp: number;
}

// Domain-separated from encryptSecret's key derivation (packages/shared/src/crypto.ts) — same
// MEDIA_NEXUS_SECRET, distinct derived key, so rotating one purpose's key material never silently
// affects the other.
function deriveSigningKey(secret: string): Buffer {
  return createHash("sha256").update(`${secret}:session-signing`).digest();
}

function base64url(input: Buffer | string): string {
  if (typeof input === "string") return Buffer.from(input, "utf8").toString("base64url");
  return input.toString("base64url");
}

/** Issues a signed, tamper-evident session cookie value carrying `passwordVersion` and a 30-day expiry. */
export function signSession(passwordVersion: number, secret: string): string {
  const now = Date.now();
  const payload: SessionPayload = { pv: passwordVersion, iat: now, exp: now + SESSION_DURATION_MS };
  const encodedPayload = base64url(JSON.stringify(payload));
  const signature = base64url(createHmac("sha256", deriveSigningKey(secret)).update(encodedPayload).digest());
  return `${encodedPayload}.${signature}`;
}

/** Verifies a value from {@link signSession}. Returns null if malformed, tampered, expired, or unsigned by `secret`. */
export function verifySession(cookieValue: string, secret: string): SessionPayload | null {
  const parts = cookieValue.split(".");
  if (parts.length !== 2) return null;
  const [encodedPayload, signature] = parts;

  const expectedSignature = base64url(createHmac("sha256", deriveSigningKey(secret)).update(encodedPayload).digest());
  const actual = Buffer.from(signature, "base64url");
  const expected = Buffer.from(expectedSignature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as SessionPayload;
    if (typeof payload.pv !== "number" || typeof payload.exp !== "number") return null;
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}
