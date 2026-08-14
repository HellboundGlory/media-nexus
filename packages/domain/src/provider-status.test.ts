// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  BACKOFF_SCHEDULE_MINUTES,
  AUTO_DISABLE_AFTER,
  nextBackoffMinutes,
  nextDisabledUntil,
  shouldAutoDisable,
  isBackedOff,
  isAutoDisabled,
  advanceRateLimitWindow,
} from "./provider-status";

describe("nextBackoffMinutes — escalating schedule", () => {
  it("escalates across the Prowlarr PerIndexerBackoffLevels tiers", () => {
    // Index = min(failures, len-1); len-1 is 6 → caps at 16 h (960 min).
    expect(nextBackoffMinutes(1)).toBe(30);
    expect(nextBackoffMinutes(2)).toBe(60);
    expect(nextBackoffMinutes(3)).toBe(120);
    expect(nextBackoffMinutes(6)).toBe(960);
  });
  it("caps at the final (16 h) tier", () => {
    expect(nextBackoffMinutes(BACKOFF_SCHEDULE_MINUTES.length)).toBe(960);
    expect(nextBackoffMinutes(50)).toBe(960);
    expect(nextBackoffMinutes(-5)).toBe(15); // negative clamps to 0 failures → first tier
  });
  it("first tier is reachable with no failures reading as 15 (not used for backoff)", () => {
    expect(nextBackoffMinutes(0)).toBe(15);
  });
});

describe("nextDisabledUntil", () => {
  it("sets disabledUntil to now + the tier for the given failure count", () => {
    const now = 1_000_000;
    expect(nextDisabledUntil(1, now)).toBe(now + 30 * 60 * 1000);
    expect(nextDisabledUntil(6, now)).toBe(now + 960 * 60 * 1000);
  });
});

describe("shouldAutoDisable", () => {
  it("is false below the threshold and true at/above it", () => {
    expect(shouldAutoDisable(AUTO_DISABLE_AFTER - 1)).toBe(false);
    expect(shouldAutoDisable(AUTO_DISABLE_AFTER)).toBe(true);
    expect(shouldAutoDisable(AUTO_DISABLE_AFTER + 5)).toBe(true);
  });
});

describe("isBackedOff", () => {
  it("is true only while the disabledUntil timestamp is in the future", () => {
    const now = 1_000_000;
    expect(isBackedOff(null, now)).toBe(false);
    expect(isBackedOff(undefined, now)).toBe(false);
    expect(isBackedOff(now + 1000, now)).toBe(true); // future → backed off
    expect(isBackedOff(now - 1000, now)).toBe(false); // elapsed → recovered
    expect(isBackedOff(now, now)).toBe(false); // exactly at boundary → not backed off
  });
});

describe("isAutoDisabled", () => {
  it("coerces boolean / 0-1 / null status", () => {
    expect(isAutoDisabled(true)).toBe(true);
    expect(isAutoDisabled(1)).toBe(true);
    expect(isAutoDisabled(false)).toBe(false);
    expect(isAutoDisabled(0)).toBe(false);
    expect(isAutoDisabled(null)).toBe(false);
    expect(isAutoDisabled(undefined)).toBe(false);
  });
});

describe("advanceRateLimitWindow — sliding window", () => {
  it("starts a fresh window and allows the first call", () => {
    const { allowed, window } = advanceRateLimitWindow(null, 1000, 3, 10);
    expect(allowed).toBe(true);
    expect(window).toEqual({ count: 1, windowStart: 1000 });
  });
  it("allows calls up to max within the window", () => {
    let w = null;
    const max = 3;
    const intervalSec = 10;
    for (let i = 1; i <= max; i++) {
      const r = advanceRateLimitWindow(w, 1000 + i, max, intervalSec);
      expect(r.allowed).toBe(true);
      w = r.window;
    }
    expect(w).toEqual({ count: max, windowStart: 1000 + 1 });
  });
  it("blocks once the window saturates, leaving state unchanged", () => {
    const max = 2;
    const a = advanceRateLimitWindow(null, 1000, max, 10);
    const b = advanceRateLimitWindow(a.window, 1001, max, 10);
    const c = advanceRateLimitWindow(b.window, 1002, max, 10);
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
    expect(c.allowed).toBe(false);
    expect(c.window).toEqual(b.window); // unchanged → keeps blocking
  });
  it("opens a new window after the interval elapses", () => {
    const max = 1;
    const first = advanceRateLimitWindow(null, 1000, max, 10); // count 1, allowed
    const blocked = advanceRateLimitWindow(first.window, 1001, max, 10); // saturated
    expect(blocked.allowed).toBe(false);
    const after = advanceRateLimitWindow(blocked.window, 1000 + 10 * 1000, max, 10); // window elapsed
    expect(after.allowed).toBe(true);
    expect(after.window.windowStart).toBe(1000 + 10 * 1000);
    expect(after.window.count).toBe(1);
  });
  it("ignores a zero/blank windowStart as no window", () => {
    const r = advanceRateLimitWindow({ count: 5, windowStart: 0 }, 1000, 2, 1);
    expect(r.allowed).toBe(true);
    expect(r.window).toEqual({ count: 1, windowStart: 1000 });
  });
});
