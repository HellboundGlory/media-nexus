# MediaNexus — Technology Decisions (ADRs)

Each decision records: **Context**, **Alternatives considered**, **Decision**, **Consequences**. Decisions are foundational
and were driven by the requirements (large app, complex domain logic, heavy async, filesystem + networking, API
compatibility, Docker-first, strong typing, strong testing, long-term maintainability) and the verified upstream facts
(`overview.md` §2).

---

## ADR-001 — Language: TypeScript across backend and frontend

- **Context:** the unified platform must implement _arr-grade domain logic (C#/GPL-3.0 upstreams) plus Seerr-grade request
  management (TypeScript/MIT upstream). A single language shares types, reduces context switching, and keeps one toolchain.
  GPL-3.0 NzbDrone code **cannot** be copied without making the whole project GPL-3.0 — see `legal/upstream-licenses.md`.
- **Alternatives:** C#/.NET (reuse NzbDrone, but GPL contamination + legacy ServiceFactory architecture + C# toolchain
  does not even exist in the dev environment); Python (no upstream parity, weaker async ecosystem for this domain); Go
  (fast but worse ecosystem for web frontends sharing types).
- **Decision:** **TypeScript** for the entire stack.
- **Consequences:** + one language, shared domain types, huge npm ecosystem, matches Seerr (MIT reuse), fast iteration.
  − we must *reimplement* _arr behavior against its documented public behavior (a deliberate, documented cost), and TS
  CPU-bound paths (rare in this I/O-bound domain) must be isolated.

## ADR-002 — Monorepo with npm workspaces

- **Context:** one repo, multiple deployables (API, web) and shared library packages. The brief's proposed structure
  (`apps/*`, `packages/*`) matches npm workspaces directly.
- **Alternatives:** pnpm (nicer, but not preinstalled in the dev env; npm guests equally well here); single package (fails
  the "extractable domains" requirement); multiple repos (too much coordination).
- **Decision:** **npm workspaces** monorepo: `apps/api`, `apps/web`, `packages/{domain,database,integrations,jobs,events,compatibility,shared}`.
- **Consequences:** + standard tooling, zero extra infra, symlinked local packages. − npm workspaces lack pnpm's strict
  node_modules; we enforce discipline via eslint `import/no-extraneous-dependencies` in CI. Turborepo-style task caching is a
  planned optional addition (works across npm workspaces).

## ADR-003 — API framework: NestJS

- **Context:** need a modular monolith whose modules equal domain boundaries, with guards/interceptors/pipes for
  auth/observability/validation and clean DI for provider contracts.
- **Alternatives:** Express/Fastify (lighter, but every cross-cutting concern hand-rolled and architecture is convention,
  not structure); Fastify+plugin (great perf, weaker opinionation for large domain-modular apps).
- **Decision:** **NestJS** (latest, v11 at scaffold time) with `@nestjs/swagger`, `@nestjs/schedule`,
  `@nestjs/event-emitter`-style integration via `packages/events`.
- **Consequences:** + batteries-included modularity, guards, DI tokens for integration contracts, first-class OpenAPI,
  huge extension ecosystem, easy microservice extraction later (matches "modular monolith first"). − Nest has magic/conventions
  to learn; mitigated with disciplined module boundaries and dependency inversion rules.

## ADR-004 — Persistence: SQLite (dev/test/small self-host) + PostgreSQL (production), via Drizzle ORM

- **Context:** all four upstreams support SQLite **and** Postgres; the brief demands Docker-first with sensible volumes and
  a migration system. We want one schema, one migration pipeline, no codegen magic.
- **Alternatives:** TypeORM (what Seerr uses; heavier runtime, Entity-decorator coupling, weaker typing); Prisma (excellent
  DX but generator/proprietary engine adds toolchain weight and Docker size); raw SQL (loses type safety).
- **Decision:** **Drizzle ORM** — two schema declarations (a SQLite dialect backed by `better-sqlite3` for local, and a
  pair-wise Postgres twin backed by `pg`) plus `drizzle-kit` migrations per dialect. The runtime dialect is chosen from the
  `DATABASE_URL` scheme at boot (`sqlite:`/`file:`/`:memory:`/bare path vs `postgres(ql)://`).
- **Consequences (accurate status — both dialects are implemented and tested, roadmap M1.1/M1.2):**
  - **Boundary cast, not "mechanical portability".** apps/api's ~49 service files are written against the SQLite-typed
    `Db` (`BetterSQLite3Database`), because the two drivers expose irreconcilable type systems (`PgTable` vs `SQLiteTable`,
    async vs sync). A Postgres handle is assigned to that type via a single documented cast confined to
    `connection.ts`'s `createDb()` — no `as any` anywhere in apps/api. `Db` also carries a `dbDialect` field
    ("sqlite"|"postgres") tagged in `createDb` so call sites can branch deterministically.
  - **Dual sync/async transaction bodies.** Drizzle's better-sqlite3 `db.transaction()` requires a *synchronously-returning*
    callback (its native wrapper wraps raw BEGIN/COMMIT around a sync call and does not await), while node-postgres's
    requires an async callback returning a Promise. These are irreconcilable in one shared callback, so every transactional
    site has a runtime dialect branch: the original sync body (`.run()/.all()`, byte-for-byte unchanged) for SQLite plus an
    `await`-based async twin for Postgres. Sync transaction slides (e.g. `deletePolymorphicRows`, `ensureAvailabilitySync`,
    each service's `markAvailabilitySync`) have corresponding async twins (`...Tx`/`...Async`) used only inside Postgres
    transaction bodies.
  - **JSONB type-parser fix.** `pg` auto-parses `json`/`jsonb` columns into JS objects before Drizzle sees them, and Drizzle's
    node-postgres session installs its own per-query `getTypeParser` that falls through to pg's **global** parser (a per-Pool
    `types` override is bypassed). To stop the shared SQLite-shaped `json` mapper from double-decoding (`JSON.parse` on an
    already-parsed object), `createDb` overrides pg's global json/jsonb parsers (OIDs 114/3802) to return raw text. The app
    runs a single DB connection, so the global mutation is confined and safe.
  - **Two SQLite-only seams remain, documented:** (1) the online-backup API (`DbHandle.backup`) is SQLite-only — on Postgres
    it rejects with "use pg_dump", and `BackupService.run()` degrades to `{skipped}` rather than hard-failing; pg_dump
    automation is out of scope. (2) Two startup backfill passes (`runSecretBackfill`, `runSettingsBlobBackfill`) are written
    in the portable async form and run in both dialects; raw `sqlite_master` introspection used by the import helper is
    SQLite-backup-only. Timestamps are stored as ISO-8601 text in both dialects (a documented tradeoff — no native
    `timestamp`/`timestamptz`).
  - **Operational difference:** a fresh SQLite boot self-migrates automatically (`AUTO_MIGRATE`); both dialects run
    migrations + static seed + the two backfills on boot the same way. − younger ecosystem than TypeORM; SQL is more explicit
    than Prisma (acceptable: we own our query layer).

## ADR-005 — Jobs: database-backed queue with in-process workers (now), Redis/BullMQ as the documented scale-out path

- **Context:** requirement 13 demands scheduling, queueing, retries, backoff, cancellation, progress, priority, persistence,
  failure state, history — without immediately adding a heavyweight external queue.
- **Alternatives:** BullMQ+Redis now (adds Redis to the deploy matrix and single-failure point; overkill for one process);
  pure in-memory timers (no history/crash-safety); Kafka/NATS (far overkill).
- **Decision:** DB-backed job framework (`job_definition` + `job_run`) with in-process workers using cron + claim leases;
  contract stable so BullMQ can replace the executor later without touching callers.
- **Consequences:** + zero infra, full history/failure/progress persistence, works on SQLite/Postgres. − single-process
  concurrency ceiling for now; mitigated by claim-lease design and documented Redis scale-out (multi-instance workers).

## ADR-006 — Events: in-process domain event bus + persisted audit log; outbox/Redis Streams later

- **Context:** events for notifications/automation/audit/integrations; avoid eventing every call.
- **Alternatives:** NATS/RabbitMQ end-to-end now (infra weight); GraphQL subscriptions (client coupling, not needed for
  server-to-server automation).
- **Decision:** framework-agnostic typed `EventBus` in `packages/events` with envelope+correlationId; audit listener
  persists important events; versioned envelope paves the path to outbox + Redis Streams.
- **Consequences:** + simple, testable, no infra. − no durable delivery until outbox lands; audit rows additionally written
  at call sites to close the gap.

## ADR-007 — Frontend: React + Vite + Tailwind CSS + TanStack Query + Zustand + React Router

- **Context:** modern, polished, one-app UX (dark/light, responsive, keyboard nav, tables/forms/dialogs/toasts/loading/
  empty/error states, command palette). React 18/19 is the shared ecosystem of all four upstreams.
- **Alternatives:** Next.js (what Seerr uses — but we don't need SSR/ship a SPA behind a static host; Vite is simpler for
  single-container Docker hosting where the API serves the built SPA directly); Svelte/Solid (nicer DX but off-ecosystem);
  plain jQuery/etc. (n/a).
- **Decision:** **Vite + React + TypeScript**, Tailwind CSS for the design system, TanStack Query for server state,
  Zustand for client state, React Router for nav. (Next.js remains acceptable later if SSR/SEO ever matters.)
- **Consequences:** + fast dev, epic ecosystem, easy static Docker hosting. − client-side only (fine for a self-hosted app).

## ADR-008 — Validation/OpenAPI: zod schemas in domain packages + NestJS class-validator DTOs → Swagger

- **Context:** API-first product with generated, versioned OpenAPI; shared domain validation; single source of truth.
- **Alternatives:** schema-only OpenAPI (hand-maintained, drifts); tsoa/typed routes generators (couples to framework).
- **Decision:** zod schemas define domain shapes (used by jobs/integrations/services and API DTOs); NestJS DTOs use
  class-validator (for Swagger metadata integration) composed from domain zod schemas where practical.
- **Consequences:** + runtime validation + Swagger in one pass, typed domain contracts. − some duplication between zod and
  class-validator; mapped in a shared mapping utility and scheduled for consolidation into a generated client (roadmap).

## ADR-009 — Docker: single-container image (API serves the built web UI), health checks

- **Context:** `docker compose up -d` with persistent volumes, timezone, health checks, secrets via env. (Docker is
  **not** available in the current dev environment; `docker/Dockerfile` and compose are authored/`docker compose
  config`-validated but not executed here — CI builds the image on tag push.)
- **Decision:** one multi-stage `docker/Dockerfile` (build context = repo root) builds `apps/web` and copies its `dist`
  into the API image at `/app/web`; the NestJS API serves the built SPA directly (static assets + a catch-all SPA-fallback
  route) on port 7373, mapped to the host via `WEB_PORT` (default 8080). There is no nginx and no second container — this
  supersedes an earlier two-container design (a separate `api` + nginx-fronted `web` container) that existed before the
  web UI became same-origin with the API; env-driven config/secret injection; `/health/live` + `/health/ready`
  healthchecks with compose `start_period`.
- **Consequences:** + simplest possible deploy (one image, one port, no CORS/reverse-proxy config to get right); one
  fewer moving part to secure or misconfigure. − the API process also serves static assets (acceptable for a self-hosted
  app that is explicitly not meant to sit behind a public reverse proxy — see `docs/security.md`). Postgres remains a
  documented future driver, not a compose service today (SQLite volume is the default), documented in
  `deployment/docker.md`.
- **No in-app self-updater (2026-08-15):** because the only supported install/update path is a container image, the app
  has nothing to replace itself with — the operator's update action is `docker pull` + restart (or their compose /
  watchtower setup). Building an `_arr`-style self-replacing `MediaNexus.Update` binary would be actively wrong for this
  deployment model. MediaNexus instead ships a read-only **update check** (roadmap P3, gap-report C8): the
  `system.updateCheck` job asks GitHub whether a newer release exists, caches the answer in memory, and surfaces a
  sidebar badge — it never touches the running binary/container. See `apps/api/src/system/update-check.service.ts`.

## ADR-010 — Auth: single-tier API key (header `X-Api-Key`), `_arr`-style

- **Context:** _arr ecosystem clients authenticate with a single `X-Api-Key`. MediaNexus originally also modeled Seerr-style
  per-user identity (accounts, roles, JWT) to back a request/approval workflow; that whole workflow — and the user
  accounts it required — was deliberately removed to match the simpler _arr trust model.
- **Decision:** API-key auth backed by `api_key` (hashed) is the **only** auth mechanism, for `/api/v1` and the
  compatibility surfaces alike. Any valid key resolves to a full-access `Principal` (`{ keyId, isAdmin: true, scopes }`)
  — there is no per-user identity, no JWT, no login screen. Bootstrap mints one system key on first run
  (`MEDIA_NEXUS_BOOTSTRAP_KEY` can pin it, e.g. for CI).
- **Consequences:** + immediate _arr-client compatibility, minimal attack surface, nothing to misconfigure around roles.
  − not intended for multi-tenant or internet-facing use — the app is meant to stay on a trusted LAN/private network (see
  `docs/security.md`). A future TMDB discover view and Plex watchlist integration (the remaining Seerr-derived roadmap
  scope) do not require reintroducing per-user accounts.

> **Superseded in part:** "no login screen" no longer holds. The browser now gets a real username/password login
> (Sonarr/Radarr-style Forms auth) issuing a signed session cookie, instead of a human having to copy an API-key
> value out of container logs on every fresh browser/device. This does **not** reintroduce per-user accounts or
> roles — it's still exactly one admin identity, just reachable two ways now (session cookie for the browser,
> `X-Api-Key` header for external/compat clients, both resolving to the same full-access `Principal`). The
> `X-Api-Key` mechanism itself, and everything else in this ADR, is otherwise unchanged. See `docs/security.md`'s
> trust-model section for the current shape.
