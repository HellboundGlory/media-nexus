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
- **Decision:** **Drizzle ORM** — schema defined in TS with precise types, `drizzle-kit` migrations (SQLite + Postgres from
  the same schema), `better-sqlite3` for local, `pg` for production.
- **Consequences (accurate status):** SQLite is fully wired now (migrations, tests, Docker default). **PostgreSQL is a
  targeted follow-up (roadmap M1.1), not yet implemented** — the schema is dialect-portable and the client factory already
  detects `postgres://` URLs and fails with a clear message so no one silently gets a broken deployment. − younger ecosystem than
  TypeORM; SQL is more explicit than Prisma (acceptable: we own our query layer).

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
  Docker nginx hosting); Svelte/Solid (nicer DX but off-ecosystem); plain jQuery/etc. (n/a).
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

## ADR-009 — Docker: multi-stage builds, compose with api+web(+optional postgres), health checks

- **Context:** `docker compose up -d` with persistent volumes, timezone, UID/GID, health checks, secrets via env.
  (Docker is **not** available in the current dev environment; Dockerfiles/compose are authored and reviewed for
  correctness but not executed here — the scaffold is equivalently validated by building and running natively.)
- **Decision:** `apps/api` and `apps/web` each get a multi-stage Dockerfile; nginx serves the web SPA and reverse-proxies
  `/api` to the API container; docker-compose wires api + web + optional `postgres`; non-root runtime user; env-driven
  config/secret injection; `/health/live` + `/health/ready` healthchecks with compose `start_period`.
- **Consequences:** + simple single-compose deploy; − Postgres left optional to keep the default lightweight (SQLite volume
  is the default), documented in `deployment/docker.md`.

## ADR-010 — Auth: API keys (header `X-Api-Key`) now; JWT/Plex-Jellyfin identity later

- **Context:** _arr ecosystem clients authenticate with `X-Api-Key`; Seerr uses identity (Plex/Jellyfin) + JWT. Unified auth
  must serve both and be forward-compatible.
- **Decision:** API-key auth backed by `api_key` (hashed) for `/api/v1` now — one wire format for automation and compat
  surfaces; JWT/session + Plex/Jellyfin login designed into the model (`user`, `api_key`, `user_settings`) and gated behind
  roadmap M6.
- **Consequences:** + immediate _arr-client compatibility, simple and testable. − no interactive login yet; explicitly
  scoped out of the scaffold (noted in API doc + README).
