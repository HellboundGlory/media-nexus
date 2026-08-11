// SPDX-License-Identifier: MIT
import { describe, it, expect, vi, afterEach } from "vitest";
import { signSession, verifySession } from "./session";

describe("session", () => {
  afterEach(() => vi.useRealTimers());

  it("round-trips a valid session", () => {
    const cookie = signSession(1, "test-secret");
    const payload = verifySession(cookie, "test-secret");
    expect(payload).not.toBeNull();
    expect(payload?.pv).toBe(1);
  });

  it("rejects a session signed with a different secret", () => {
    const cookie = signSession(1, "test-secret");
    expect(verifySession(cookie, "wrong-secret")).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const cookie = signSession(1, "test-secret");
    const [, signature] = cookie.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ pv: 999, iat: Date.now(), exp: Date.now() + 1e10 })).toString("base64url");
    expect(verifySession(`${forgedPayload}.${signature}`, "test-secret")).toBeNull();
  });

  it("rejects a malformed cookie value", () => {
    expect(verifySession("not-a-valid-session", "test-secret")).toBeNull();
  });

  it("rejects an expired session", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const cookie = signSession(1, "test-secret");
    vi.setSystemTime(new Date("2026-03-01T00:00:00Z")); // >30 days later
    expect(verifySession(cookie, "test-secret")).toBeNull();
  });
});
