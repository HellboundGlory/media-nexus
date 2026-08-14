// SPDX-License-Identifier: MIT
import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import { ConfigService } from "../system/config.service";
import {
  advanceRateLimitWindow,
  isAutoDisabled,
  isBackedOff,
  nextDisabledUntil,
  shouldAutoDisable,
  type ProviderType,
  type RateLimitWindow,
} from "@medianexus/domain";

/** What kind of provider call is being gated. `query`/`poll` share the query
 *  rate-limit window; `grab` uses the grab window; `health` is not rate-limited
 *  (the manual test()/refreshAll() recovery path never calls beforeCall anyway). */
export type CallKind = "query" | "poll" | "grab" | "health";

export interface GateResult {
  skip: boolean;
  reason?: "autoDisabled" | "backoff" | "rateLimited";
}

/**
 * Generic per-provider health/backoff/rate-limit gate (roadmap P1, gap report B10).
 * Mirrors Prowlarr's `ProviderStatusServiceBase`: a repeatedly-failing indexer or
 * download client is backed off for escalating windows and finally auto-disabled, and
 * indexers are rate-limited with a sliding window, instead of every dead provider being
 * hit on every search/grab/poll cycle.
 *
 * State lives in the generic `provider_status` table (keyed `providerType, providerId`).
 * The pure escalation/window math is in `packages/domain/src/provider-status.ts`; this
 * service only reads/writes rows and flips `indexer.status` as the single writer of that
 * flag (the old direct writes in IndexersService.test() were removed).
 *
 * Failure/success *events* are NOT emitted here — call sites already publish
 * `IndexerFailed`/`DownloadClientFailed` at the exact points they did before B10, so
 * wiring this service in does not change, duplicate, or drop any existing event.
 *
 * Invariant: this never touches a provider's `enabled` flag. Backoff/auto-disable is a
 * soft skip applied by the wired call sites; the explicit recovery path (manual
 * `test()`/healthcheck, or `reset()`) clears it.
 */
@Injectable()
export class ProviderStatusService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly config: ConfigService,
  ) {}

  private async ensureRow(type: ProviderType, providerId: string, now: string) {
    const existing = await this.db.select().from(schema.providerStatus)
      .where(and(eq(schema.providerStatus.providerType, type), eq(schema.providerStatus.providerId, providerId)))
      .limit(1);
    if (existing[0]) return existing[0];
    const row = {
      id: `${type}:${providerId}`,
      providerType: type,
      providerId,
      consecutiveFailures: 0,
      escalationLevel: 0,
      disabledUntil: null,
      autoDisabled: false,
      lastError: null,
      lastFailureAt: null,
      lastSuccessAt: null,
      rateLimit: null,
      updatedAt: now,
    };
    await this.db.insert(schema.providerStatus).values(row)
      .onConflictDoNothing({ target: schema.providerStatus.id });
    return (await this.db.select().from(schema.providerStatus)
      .where(and(eq(schema.providerStatus.providerType, type), eq(schema.providerStatus.providerId, providerId)))
      .limit(1))[0];
  }

  /**
   * Gate a provider call. `providerId` may be absent (e.g. a memory client with no row)
   * — such calls are never gated. Returns whether the call should be skipped and why.
   */
  async beforeCall(type: ProviderType, providerId: string | null | undefined, kind: CallKind): Promise<GateResult> {
    if (!providerId) return { skip: false };
    const now = Date.now();
    const row = await this.ensureRow(type, providerId, new Date(now).toISOString());

    if (isAutoDisabled(row.autoDisabled)) return { skip: true, reason: "autoDisabled" };
    if (isBackedOff(parseIso(row.disabledUntil), now)) return { skip: true, reason: "backoff" };

    // Rate-limit gate — indexers only, per the scoping plan (download clients back off
    // but aren't token-bucketed). query/poll share the query window; grab uses its own.
    if (type === "indexer") {
      const key = kind === "grab" ? "grab" : "query";
      const cfg = await this.config.get();
      const intervalSec = cfg["indexers.rateLimitWindowSeconds"];
      const max = (key === "grab" ? cfg["indexers.maxGrabsPerWindow"] : cfg["indexers.maxQueriesPerWindow"]);
      const current = row.rateLimit?.[key] as RateLimitWindow | undefined;
      const { allowed, window } = advanceRateLimitWindow(current, now, max, intervalSec);
      if (!allowed) {
        return { skip: true, reason: "rateLimited" };
      }
      const nextRateLimit = {
        ...(row.rateLimit ?? {}),
        [key]: window,
      };
      await this.db.update(schema.providerStatus)
        .set({ rateLimit: nextRateLimit, updatedAt: new Date(now).toISOString() })
        .where(eq(schema.providerStatus.id, row.id));
    }
    return { skip: false };
  }

  /** Record a failure: escalate the backoff window, auto-disable at the threshold,
   *  and (for indexers) flip the single-writer `status` flag to `error`. */
  async recordFailure(type: ProviderType, providerId: string | null | undefined, error: unknown): Promise<void> {
    if (!providerId) return;
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const row = await this.ensureRow(type, providerId, nowIso);
    const failures = row.consecutiveFailures + 1;
    const disabledUntil = nextDisabledUntil(failures, now);
    const autoDisabled = shouldAutoDisable(failures);
    await this.db.update(schema.providerStatus)
      .set({
        consecutiveFailures: failures,
        escalationLevel: Math.min(failures, 6),
        disabledUntil: new Date(disabledUntil).toISOString(),
        autoDisabled,
        lastError: (error as Error)?.message ?? "unknown error",
        lastFailureAt: nowIso,
        updatedAt: nowIso,
      })
      .where(eq(schema.providerStatus.id, row.id));
    if (type === "indexer") {
      await this.db.update(schema.indexer)
        .set({ status: "error", lastError: (error as Error)?.message ?? "unknown error", updatedAt: nowIso })
        .where(eq(schema.indexer.id, providerId));
    }
  }

  /** Record a success: reset the counter/backoff/auto-disable and (for indexers) flip
   *  `status` back to `ok`. Clears the auto-disable so the provider is usable again. */
  async recordSuccess(type: ProviderType, providerId: string | null | undefined): Promise<void> {
    if (!providerId) return;
    const now = new Date().toISOString();
    const row = await this.ensureRow(type, providerId, now);
    await this.db.update(schema.providerStatus)
      .set({
        consecutiveFailures: 0,
        escalationLevel: 0,
        disabledUntil: null,
        autoDisabled: false,
        lastError: null,
        lastSuccessAt: now,
        updatedAt: now,
      })
      .where(eq(schema.providerStatus.id, row.id));
    if (type === "indexer") {
      await this.db.update(schema.indexer)
        .set({ status: "ok", lastError: null, updatedAt: now })
        .where(eq(schema.indexer.id, providerId));
    }
  }

  /** Cheap skip check for call sites that filter providers up front (pickDownloadClient). */
  async isSkipped(type: ProviderType, providerId: string | null | undefined): Promise<boolean> {
    if (!providerId) return false;
    const row = await this.ensureRow(type, providerId, new Date().toISOString());
    const now = Date.now();
    return isAutoDisabled(row.autoDisabled) || isBackedOff(parseIso(row.disabledUntil), now);
  }

  status(type: ProviderType, providerId: string) {
    return this.db.select().from(schema.providerStatus)
      .where(and(eq(schema.providerStatus.providerType, type), eq(schema.providerStatus.providerId, providerId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  /** Manual clear / re-enable — the DB-backed equivalent of resetting a Prowlarr provider. */
  async reset(type: ProviderType, providerId: string): Promise<void> {
    await this.recordSuccess(type, providerId);
  }

  /** Ids of every provider of a type that is currently auto-disabled (for health checks). */
  async autoDisabledIds(type: ProviderType): Promise<Set<string>> {
    const rows = await this.db.select({ providerId: schema.providerStatus.providerId })
      .from(schema.providerStatus)
      .where(and(eq(schema.providerStatus.providerType, type), eq(schema.providerStatus.autoDisabled, true)));
    return new Set(rows.map((r) => r.providerId));
  }

  /** Remove status rows when a provider is deleted (provider_status has no FK — the
   *  referent can be an indexer or a download client). */
  async clearProvider(type: ProviderType, providerId: string): Promise<void> {
    await this.db.delete(schema.providerStatus)
      .where(and(eq(schema.providerStatus.providerType, type), eq(schema.providerStatus.providerId, providerId)));
  }
}

/** `provider_status.disabled_until` is an ISO text column; parse to epoch ms for the pure
 *  predicate (null/NaN → null so an empty value is treated as "not backed off"). */
function parseIso(v: string | null | undefined): number | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}
