---
title: "B10 — Provider Status Service (backoff, auto-disable, rate limiting)"
tags: [roadmap-p1, gap-report-b10, providers, indexers, download-clients]
status: draft
created: 2026-08-14
---

# B10 — Provider status service (backoff, auto-disable, rate limiting)

Gap report finding **B10**, roadmap P1. One generic per-provider health/state
service so a repeatedly-failing indexer or download client is **backed off** and
eventually **auto-disabled** instead of being hit on every search/grab/poll cycle,
matching upstream Sonarr/Radarr/Prowlarr behaviour. The report's one sentence:
"a dead indexer currently adds its full ~20s HTTP timeout to every search, and
there's no shared status-tracking service."

## What exists today (investigated, not trusting the report's line refs)

- `IndexersService.fetchReleases()` (apps/api/src/indexers/indexers.service.ts,
  shared by `search()` and `pollRecent()`/RSS feed poll) fans out over
  `providers.configuredIndexers()` (all `enabled` rows), `try/catch` per indexer,
  publishes `IndexerFailed`, and **retries every dead indexer on every call, forever**.
- `IndexersService.grab()` re-search loop wraps failures in `.catch(() => [])`
  (silent). `AcquisitionService.syncAll()` catches a client's `getQueue()` failure,
  publishes `DownloadClientFailed`, and retries on the next 15s tick. Neither has
  any backoff/disable concept.
- `indexer.status` is a bare `'ok' | 'error' | 'disabled'` column, only written by
  `IndexersService.test()` (the manual/`discovery.indexerRefresh` healthcheck).
  `download_client` has **no** status column at all.
- `configuredIndexers()`/`configuredDownloadClients()` (demo.providers.ts,
  `@Global`) filter only on `enabled === true`; providers are rebuilt per call.
- Health checks (B9, `packages/domain/src/health.ts` + health-check.service.ts)
  already read `indexer.status`/`downloadClients.reachable`, but know nothing of
  backoff/auto-disable.
- No per-provider failure counter, escalation level, disabled-until timestamp, or
  rate limit anywhere. J5 (re-instantiate per call) and D1 (Newznab wire throttle)
  are explicitly out of scope unless they block B10 — they don't.

## Design

Follow the established pattern: **pure backoff/state/rate-limit math in
`packages/domain`** (like `decision.ts`/`health.ts`), **DB-backed service in
`apps/api`** (like `decision.service.ts`/`health-check.service.ts`).

### 1. Pure domain module — `packages/domain/src/provider-status.ts`

- `BACKOFF_SCHEDULE_MINUTES = [15, 30, 60, 120, 240, 480, 960]` (Prowlarr's
  PerIndexerBackoffLevels, capped at 16 h). Index =
  `min(consecutiveFailures, len-1)`.
- `nextBackoffMinutes(failures)` → scheduled minutes (escalating, capped).
- `shouldAutoDisable(failures)` → `failures >= AUTO_DISABLE_AFTER` (default 10).
- `isBackedOff(disabledUntil, now)` / `isAutoDisabled(autoDisabled)`.
- Sliding-window rate limit: `checkRateLimit(window, now, max, intervalSec)` and
  `advanceRateLimitWindow(window, now, intervalSec)` returning `{ allowed, count,
  windowStart }` — a small pure function holding the window bookkeeping; the
  DB/service decides whether to persist.

### 2. New table — `provider_status` (migration 0013)

Generic across provider kinds (indexer, downloadClient; notification/importList
later). Keyed by `(providerType, providerId)` + unique index.

```
id                     text PK
providerType           text   -- 'indexer' | 'downloadClient'
providerId             text   -- indexer.id / download_client.id
consecutiveFailures    int    default 0
escalationLevel        int    default 0      -- derived on write, stored for cheap read/surfacing
disabledUntil          text   null (ISO; null = not backed off)
autoDisabled           int    default 0      -- hard-disabled after repeated failure; needs recovery
lastError              text   null
lastFailureAt          text   null
lastSuccessAt          text   null
rateLimit              json   null  -- { query?: {count, windowStart}, grab?: {count, windowStart} } (indexers)
updatedAt              text
unique(providerType, providerId)
```

### 3. Service — `apps/api/src/providers/provider-status.service.ts`

Registered in the existing `@Global` `DemoProvidersModule` (DB + ConfigService
already injectable). API mirrored on Prowlarr's `ProviderStatusServiceBase`:

- `beforeCall(type, id, kind: 'query'|'grab'|'poll'|'health')` → `{ skip: boolean,
  reason? }`. Applies **backoff** gate (skip if `disabledUntil > now` or
  `autoDisabled`), then **rate-limit** gate (indexers only) which persists the
  sliding window.
- `recordFailure(type, id, error)` → increment counter, escalate
  `disabledUntil = now + nextBackoffMinutes`, set `lastError`/`lastFailureAt`, flip
  `indexer.status='error'` (download client has no status column), **auto-disable**
  at threshold, emit `IndexerFailed`/`DownloadClientFailed`.
- `recordSuccess(type, id)` → reset counter, clear backoff + autoDisable, set
  `lastSuccessAt`, flip `indexer.status='ok'`.
- `status(type, id)` / `reset(type, id)` (manual clear / re-enable) /
  `listDisabled(type)`.
- Helpers `isSkipped(type, id)` for cheap reuse.

### 4. Wiring at every provider call site

- `IndexersService.fetchReleases()` — per indexer: `beforeCall()`; skip if
  gated; on success `recordSuccess`, on error `recordFailure` (keep the
  `IndexerFailed` event). **This is the headline fix** (dead indexers stop being
  hit on every search/poll).
- `IndexersService.grab()` — apply backoff gate to the re-search loop; record
  indexer success/failure around searches and download-client
  success/failure around `addRelease()`.
- `IndexersService.test()` / `refreshAll()` — the **explicit recovery path**,
  deliberately **not** gated by backoff (a manual test must reach a backed-off
  provider). Always `recordFailure`/`recordSuccess`. Its former direct
  `db.update(indexer).set({ status })` is **removed** — `ProviderStatusService`
  is the single writer of `indexer.status`.
- `DownloadClientsService.test()` — the **download-client mirror** of the
  recovery path (reviewer correction #1: without it, an auto-disabled download
  client had no code path that ever cleared it, since `syncAll()`/`pickDownloadClient()`
  are gated *skip* paths). Also ungated, always `recordFailure`/`recordSuccess`,
  publishing `DownloadClientFailed` on failure.
- `AcquisitionService.syncAll()` — per client: gate `getQueue()` on backoff; skip
  gated clients; `recordSuccess`/`recordFailure` (keep `DownloadClientFailed`
  event). Polls of a dead client are skipped instead of retried every 15 s.
- `ProvidersService.pickDownloadClient()` — prefer/only-see clients not in
  backoff/auto-disabled, so grabs don't land on a dead client.
- Health checks (B9) — extend `HealthContext.indexers`/`.downloadClients` entries
  with `disabled` (auto-disabled) and add one new check each
  (`indexers.autoDisabled`, `downloadClients.autoDisabled`) so a fully
  disabled pool surfaces as a health warning/error. (Feed the result into health
  checks, per the finding.)

### 5. New settings (packages/shared/src/settings.ts)

- `indexers.rateLimitWindowSeconds` (default 60)
- `indexers.maxQueriesPerWindow` (default 20, per indexer — generous, doesn't break
  normal ops)
- `indexers.maxGrabsPerWindow` (default 5, per indexer)
Backoff schedule + auto-disable threshold are domain constants (not settings) for
now; can move to settings later if needed.

## Out of scope (noted, not touched)

- **D1** Newznab/Torznab wire-level caps/paging/throttle — B10's rate limit is the
  generic per-provider token bucket, independent of Newznab's own protocol
  throttling.
- **J5** provider re-instantiation-per-call — unchanged; B10 works with rebuilt
  providers because state lives in the DB.
- **J9** plaintext credentials — unrelated.
- Notifications/import-list providers — the table and service are generic and ready,
  but enforcement is wired only for indexers + download clients (B10's stated scope).

## Tests

- **Unit (`packages/domain/src/provider-status.test.ts`):** escalation schedule,
  auto-disable threshold, backoff/disabled predicates, rate-limit window pure logic.
- **Integration (`apps/api/test/provider-status.spec.ts`, real DB via
  `createDb`/migrations, following rss-poll.spec.ts's stub-the-provider pattern):**
  a failing (throwing) indexer provider driven through `IndexersService.fetchReleases()`
  → verify consecutive failure count rises, `disabledUntil` set, more failures →
  `autoDisabled`, then `fetchReleases()` **skips** the indexer (provider.search never
  called). Recovery: manual `test()` success → `recordSuccess` → provider queried
  again. Plus a healthy-provider success path and a download-client backoff skip via
  `syncAll()`.

## Live verification

Boot built API against a scratch DB in `/tmp` (same procedure as B11: port offset,
`MEDIA_NEXUS_WEB_DIR=apps/web/dist`), configure an indexer pointing at a dead/nonexistent
endpoint, drive searches and watch `provider_status`/`indexer.status`, confirm dead
indexers are skipped and auto-disable kicks in. Confirm via `GET /api/v1/system/health`.

## Landing

Feature branch `p1-provider-status` off `main`; one commit; `merge --ff-only`; push,
matching B5/B7/B8/B9/B11. Report branch+commit to Claude for review first.
