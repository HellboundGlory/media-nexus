// SPDX-License-Identifier: MIT

/**
 * Provider status / backoff / rate-limit math (roadmap P1, gap report B10).
 *
 * Pure domain code — no DB/network access, mirroring the split used by
 * `decision.ts` / `health.ts`. A repeatedly-failing indexer or download client
 * must be **backed off** and eventually **auto-disabled** instead of being hit
 * on every search/grab/poll cycle, matching upstream Sonarr/Radarr/Prowlarr
 * behaviour.
 *
 * The DB-backed writer lives in `apps/api/src/providers/provider-status.service.ts`;
 * this file only holds the pure escalation schedule and window math so it can be
 * unit-tested in isolation and reused by any future provider kind.
 */

export type ProviderType = "indexer" | "downloadClient";

/**
 * Prowlarr's `PerIndexerBackoffLevels`, capped at 16 h. EscalationLevel starts
 * at 0 and is incremented on each consecutive failure, so after the FIRST
 * failure it indexes into the 30-min tier (Prowlarr parity: a provider is not
 * backed off on its very first successful catalog, only after a failure).
 * Index is clamped to the final (16 h) tier.
 */
export const BACKOFF_SCHEDULE_MINUTES = [15, 30, 60, 120, 240, 480, 960] as const;

/** Consecutive-failure threshold after which a provider is hard-auto-disabled
 *  (requires an explicit recovery path — manual test / health check — to clear). */
export const AUTO_DISABLE_AFTER = 10;

/** Scheduled backoff for a given consecutive-failure count (escalating, capped
 *  at the final 16 h tier). `failures` is the count AFTER the failure that is
 *  being recorded (>= 1). Index = min(failures, len-1) per the scoping plan. */
export function nextBackoffMinutes(failures: number): number {
  const f = Math.max(0, Math.floor(failures));
  return BACKOFF_SCHEDULE_MINUTES[Math.min(f, BACKOFF_SCHEDULE_MINUTES.length - 1)];
}

/** Absolute epoch-ms time at which a provider with `failures` consecutive
 *  failures comes back out of backoff. */
export function nextDisabledUntil(failures: number, now: number): number {
  return now + nextBackoffMinutes(failures) * 60 * 1000;
}

export function shouldAutoDisable(failures: number): boolean {
  return failures >= AUTO_DISABLE_AFTER;
}

/** `disabledUntil` is an epoch-ms timestamp (callers parse the stored ISO text). */
export function isBackedOff(disabledUntil: number | null | undefined, now: number): boolean {
  return disabledUntil != null && disabledUntil > now;
}

export function isAutoDisabled(autoDisabled: boolean | 0 | 1 | undefined | null): boolean {
  return Boolean(autoDisabled);
}

/** Sliding-window state for a single rate-limit counter. `windowStart` is the
 *  epoch-ms timestamp the current window began; `count` is calls so far in it. */
export interface RateLimitWindow {
  count: number;
  windowStart: number;
}

export interface WindowAdvance {
  allowed: boolean;
  window: RateLimitWindow;
}

/**
 * Advances one sliding-window rate-limit counter for a call that is about to
 * happen, returning whether it is allowed and the next window state to persist.
 *
 * - If no window exists or the current window has elapsed (>= `intervalSec`),
 *   a fresh window starts with this call counted (allowed).
 * - Otherwise the call is allowed until the window saturates at `max`.
 * - A denied call leaves the window unchanged (so it keeps blocking) and the
 *   caller decides whether to persist the unchanged state.
 */
export function advanceRateLimitWindow(
  window: RateLimitWindow | null | undefined,
  now: number,
  max: number,
  intervalSec: number,
): WindowAdvance {
  const intervalMs = Math.max(1, intervalSec) * 1000;
  const cur = window && window.windowStart > 0 ? window : null;
  if (!cur || now - cur.windowStart >= intervalMs) {
    return { allowed: true, window: { count: 1, windowStart: now } };
  }
  if (cur.count < max) {
    return { allowed: true, window: { ...cur, count: cur.count + 1 } };
  }
  return { allowed: false, window: cur };
}
