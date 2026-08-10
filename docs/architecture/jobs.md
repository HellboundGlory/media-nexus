# MediaNexus — Background Job Architecture

## 1. Requirements (from the brief)

Scheduling, queuing, retries, backoff, cancellation, progress, priority, concurrency, persistence, failure state, job
history — plus graceful shutdown, observability (job IDs), and the ability to trigger from schedules, UI, API commands and
domain events.

## 2. Options considered

| Option | Fit | Verdict |
|---|---|---|
| **Database-backed jobs + in-process scheduler/workers** | Middleweight; zero new infra; crash-safe via DB row state; good for single/multi-single-app deploy | ✅ **Chosen now** |
| Redis + BullMQ / Redis Streams | Excellent for distributed workers and scale-out | ⏳ Scale-out path (documented, not built) |
| External heavyweight queque (Kafka/RabbitMQ/NATS) | Overkill for a self-hosted app | ❌ Not until proven necessary |
| In-process timers only (no persistence) | Simple but loses history, no crash recovery | ❌ |

Decision rationale recorded in `technology-decisions.md` (jobs row) and summarized: the monolith starts as one process;
jobs are I/O-bound (network search, filesystem import, indexer polling) and fit fine in one worker set. A DB row per job
run gives history, failure state, progress, retries and observability with zero infrastructure. The job **contract** is
documented so swapping the execution backend for BullMQ/Redis later does not change callers.

## 3. Model

- `job_definition` (persisted): `key`, `name`, `description`, `schedule` (cron), `enabled`, `timeoutMs`, `maxRetries`,
  `retryBackoffMs`, `priority`, `concurrencyLimit`.
- `job_run` (persisted): `jobKey`, `status`, `trigger`, `attempt`, `progress`, `message`, `error`, `startedAt`,
  `finishedAt`, `payload`, `result`, plus the owning request/correlation id.

### 4. Execution flow

```
Cron tick / manual command / domain event
        │
        ▼
Scheduler ──enqueue──► job_run(status=queued, attempt=1, requestId)
        │
        ▼
Worker (N) — claim next eligible row (priority, concurrency limit, dueAt)
        │  start: status=running
        │  ...execute job... (progress updates, event emission, audit)
        ├─ success → status=succeeded, result saved
        ├─ failure & attempts < maxRetries → status=retrying, attempt+=1, exponential backoff (dueAt=now+backoff)
        └─ failure & exhausted → status=failed, error preserved
```

- **Concurrency:** worker pool (configurable `JOB_CONCURRENCY`, default e.g. 2) claims rows with a `claimedAt` lease;
  single-writer safety comes from a `FOR UPDATE`/`BEGIN IMMEDIATE` claim on SQLite and `SELECT ... FOR UPDATE SKIP LOCKED`
  on Postgres. Distributed claim (Redis) is the documented scale-out path.
- **Retries/backoff:** exponential `backoffBase * 2^(attempt-1)` (+ jitter), bounded by `maxRetries`.
- **Timeout/cancellation:** per-job `timeoutMs` → mark a runaway run `timed_out`; cancellation is a status flag checked by
  cooperative jobs between awaits (true thread-kill is unsafe in-process; documented).
- **Triggers:** `scheduled` (cron), `manual` (API command), `event` (domain event → job mapping, e.g. `RequestApproved` →
  `media.searchForRequest`).
- **History/observability:** every terminal run persists; failed runs carry `error` + link to request/correlation id.
  Health endpoint includes latest job statuses; audit log records manual triggers.

## 5. Scaffold reality check

In the scaffold: the model (definitions + runs), scheduler wiring (`@nestjs/schedule` cron → enqueue), a worker that runs
`system.healthCheck` (writes a health job run + last-status), the manual command endpoint
`POST /api/v1/system/commands/:jobKey`, retry/backoff state machine, and an integration test that schedules+tells a job
run end-to-end. The `packages/jobs` core is framework-agnostic (Nest wrapper lives in `apps/api/src/jobs`) and unit-tested
independently of HTTP.

## 6. Job catalog (seed)

| key | schedule | purpose |
|---|---|---|
| `system.healthCheck` | `*/5 * * * *` | last-job heartbeat + system status row |
| `discovery.indexerRefresh` | `0 */6 * * *` | re-check configured indexer health (planned body) |
| `media.rssSync` | `*/15 * * * *` | RSS-poll indexers for new content (milestone M2) |
| `system.metadataCleanup` | `0 4 * * *` | prune stale media_availability/history (planned body) |
| `acquisition.downloadMonitor` | `*/1 * * * *` | poll download clients + import completed downloads (demo client today) |
| `media.searchForRequest` | event-triggered | search indexers to fulfil an approved request (stub body; real search in M1) |
