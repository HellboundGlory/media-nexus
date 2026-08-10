# MediaNexus — Architecture Overview

> Status: **Initial architecture** (Phase A–E). This document establishes the architecture implemented by the scaffold and
> the direction for forthcoming milestones. See [docs/implementation/roadmap.md](../implementation/roadmap.md) for what is
> built now versus next.

## 1. Purpose

MediaNexus is a single, self-hostable media-automation platform that provides the combined capabilities of **Prowlarr**
(indexers), **Sonarr** (TV), **Radarr** (movies) and **Seerr** (user requests) through **one coherent application**: one UI,
one backend, one domain model, one auth system, one job/event architecture, one configuration system, one API surface,
Docker-first deployment, and strong interoperability with the surrounding _arr ecosystem.

This is **not** a skin that embeds the four existing UIs, and it is **not** four cloned apps behind one login. It is a new
codebase with a unified model, where movie and TV automation share infrastructure, and where compatibility with the
existing ecosystem is provided by explicit, isolated adapters.

## 2. Research basis and verified facts

The companion deep-research report (`deep-research-report.md`) was reviewed in full and used as an *input*, not as
unquestionable truth. Its claims were verified against the upstream repositories (licenses, SDK versions, frontend
frameworks, package manifests, source layout). Corrected/confirmed findings:

| Project | Backend | Frontend | Public API | Real-time | DB | Auth | License |
|---|---|---|---|---|---|---|---|
| Sonarr | C# / .NET 10 (`global.json`) | React 18.3, TanStack Query, webpack | v3 + v5 (`Sonarr.Api.V3` / `Sonarr.Api.V5`, publishes `openapi.json`) | SignalR | SQLite (default) + Postgres | API key (header `X-Api-Key`), optional forms login | **GPL-3.0** |
| Radarr | C# / .NET 8 | React 18 + webpack | v3 (`Radarr.Api.V3`) | SignalR | SQLite + Postgres | API key | **GPL-3.0** |
| Prowlarr | C# / .NET 8 | React 18, webpack | v1 (`Prowlarr.Api.V1`) | SignalR | SQLite + Postgres | API key | **GPL-3.0** |
| Seerr | Node/Express 5, TypeORM, node-schedule, JSON-RPC-ish REST | Next.js 16, React 19, Tailwind CSS | v1 (`/api/v1`, OpenAPI YAML validated) | Polling (React Query) | SQLite + Postgres (`pg`) | Plex/Jellyfin login + local JWT | **MIT** |

Corrections to the research document, verified from source:

1. **Not ".NET 6"** — Sonarr targets the **.NET 10** SDK; Radarr/Prowlarr target **.NET 8**. All three still share the
   same `NzbDrone.*` codebase family (`NzbDrone.Common`, `NzbDrone.Core`, `NzbDrone.Http`, `NzbDrone.SignalR`, plus one
   `*.Api.Vx` project per app).
2. **Not "React 17/Redux for Prowlarr"** — Prowlarr's frontend is **React 18.3** (webpack, `connected-react-router`).
3. **All four apps support SQLite and PostgreSQL** (SQLite is the default); the _arr apps ship `postgres.runsettings` for
   integration tests.
4. **Realtime is a first-class _arr feature** via **SignalR** (`@microsoft/signalr` in every _arr frontend) — a unified app
   should plan realtime too, not just polling.
5. Sonarr v4 now ships **two API generations (v3 and v5)** in one process — evidence that the ecosystem treats API
   versions as coexisting surfaces that must keep working.
6. The _arr apps authenticate every API call with a header API key (`X-Api-Key`); Seerr uses an entirely different model
   (Plex/Jellyfin identity + JWT). The unified app must reconcile both.

### Architectural conclusions drawn from research

- The four projects are **two different stacks**: the _arr family (C#, GPL-3.0, shared NzbDrone codebase) and Seerr
  (TypeScript, MIT). Any "merge" that copies NzbDrone source drags a large GPL-3.0, tightly-coupled legacy codebase into
  the heart of the new app. This conflicts with the goal of a clean modular monolith and imposes GPL-3.0 on the whole
  product. **Conclusion:** reimplement _arr capabilities against their *documented behavior* and *public API specs* on a
  clean architecture; treat Seerr (MIT) as the only upstream whose code may be directly adapted (with attribution), and
  even then only pattern-wise. See [docs/legal/upstream-licenses.md](../legal/upstream-licenses.md).
- The _arr "one big Core project + service locator" internal structure is **not** the architecture to imitate; its
  *capability set* is. This justifies the modular-monolith design below.
- Shared/reusable infrastructure across all four: indexers/search, download clients, scheduler, notifications, metadata,
  a unified quality-profile concept, and a users/permissions model (only Seerr has one — it must become the unified
  default).

## 3. Architecture principles

1. **Modular monolith first.** One deployable backend with strong internal module boundaries; individual domains can be
   extracted later without a rewrite. No premature microservices, no distributed system until the monolith proves it needs
   one.
2. **Unified domain model.** Movies and series share acquisition/quality/download infrastructure where behavior is the
   same; domain differences are preserved where they are real (episode vs movie file import, season monitoring).
3. **API-first.** A documented, versioned `/api/v1` surface is a first-class product for the web UI, mobile, automation,
   and third parties.
4. **Explicit compatibility layer.** Existing-ecosystem APIs (Sonarr/Radarr/Prowlarr/Seerr) are served by isolated
   adapters that translate into the native domain model; they never dictate internal architecture.
5. **Contract-first integrations.** External systems (indexers, download clients, metadata, media servers, notification
   sinks) implement explicit TypeScript interfaces behind provider registries — never ad-hoc calls scattered in core code.
6. **Docker-first** deployment with persistent volumes, health checks, graceful shutdown, secrets via environment.
7. **Security by default.** API keys/JWT, never log or expose credentials, correlation IDs, audit log for admin actions.
8. **Observability from day one.** Structured logs, request IDs, job IDs, health/readiness endpoints, metrics-friendly
   design.
9. **Every major decision is documented** (this directory), **tests accompany meaningful functionality**, and the repo
   stays buildable/runnable at every stage.

## 4. Component architecture

```text
                          ┌──────────────────────┐
                          │   apps/web (React)    │  Vite + Tailwind + TanStack Query + Zustand
                          └──────────┬───────────┘
                                     │  HTTP JSON /api/v1   (+ SSE realtime, planned)
                          ┌──────────▼───────────┐
                          │   apps/api (NestJS)  │  modular monolith: modules per domain
                          └──────────┬───────────┘
       ┌─────────────────────────────┼───────────────────────────────┐
       │              │              │              │                │
 ┌─────▼─────┐  ┌──────▼──────┐  ┌───▼─────┐  ┌─────▼─────┐   ┌──────▼──────┐
 │ media     │  │ discovery   │  │ requests│  │ system    │   │ users/auth  │
 │ movies/ser│  │ indexers    │  │ (seerr) │  │ commands  │   │ api keys    │
 └───────────┘  └─────────────┘  └─────────┘  └───────────┘   └─────────────┘
       │              │              │                │               │
       └──────────────┴──────────────┴────────────────┴───────────────┘
                                     │
                    ┌────────────────▼─────────────────┐
                    │  packages/domain (unified model) │   + packages/events (domain events)
                    └────────────────┬─────────────────┘
                                     │
      ┌──────────────────┬───────────┼───────────────┬───────────────────────┐
      │                  │           │               │                       │
┌─────▼─────┐      ┌──────▼─────┐   ┌▼───────┐   ┌────▼──────┐   ┌────────── ▼──────┐
│ jobs      │      │ integrations│   │ compat │   │ database │   │ shared (config,   │
│ DB-backed │      │ provider    │   │ layer  │   │ Drizzle  │   │ observability)    │
│ scheduler │      │ contracts   │   │ adapters│   │ SQLite/PG│   │                   │
└───────────┘      └─────────────┘   └────────┘   └──────────┘   └───────────────────┘
```

- **API** holds HTTP concerns (controllers, guards, validation, OpenAPI). Business logic lives in domain services.
- **Domain/Event layer** is the only thing services talk to; it does not know about HTTP or compatibility.
- **Jobs** run scheduled/queued work (RSS sync, searches, imports, health checks) against the same domain layer.
- **Integrations** implement provider contracts (indexer, download client, …) and are injected into domain services.
- **Persistence** is Drizzle over SQLite (dev/test/small self-host) or PostgreSQL (production), via one schema and one
  migration system.

## 5. Repository map

```text
media-nexus/
├── apps/
│   ├── api/            NestJS API (modules: system, media, discovery, acquisition, requests, users, jobs, notifications)
│   └── web/            React/Vite UI (dashboard, library, activity, requests, system shells)
├── packages/
│   ├── domain/         Unified domain model: entity types, zod validation schemas, domain constants
│   ├── database/       Drizzle schema (full intended model), client factory, migrations, seeds
│   ├── integrations/   Provider contracts: Indexer, DownloadClient, Metadata, Notification, MediaServer, Auth, Storage
│   ├── jobs/           DB-backed job framework: definitions, runs, queue, retries, progress
│   ├── events/         Domain event envelope + in-process bus + audit listener
│   ├── compatibility/  Compatibility-layer framework + adapter scaffolding (sonarr/radarr/prowlarr/seerr)
│   └── shared/         Config/env schemas, error model, API constants, logger, IDs
├── docs/               architecture / implementation / development / deployment / legal
├── docker/             compose files, nginx conf, env templates, entrypoints
├── scripts/            dev/ops helpers (db migrate, seed, healthcheck)
├── .github/            CI workflow
├── Dockerfile          root convenience Dockerfiles inherited by apps
├── docker-compose.yml  top-level `docker compose up -d`
└── README.md
```

> **Status accuracy:** the scaffold is verified **native** (build, test, run). Docker images/compose are authored and I ran `docker compose config`-valid checks, but they are **not executed** here (no Docker daemon in this environment) — CI builds both images before we claim Docker-verified. PostgreSQL is a planned driver (M1.1); SQLite is the live default.

## 6. Decision summary (details in `technology-decisions.md`)

| Concern | Decision |
|---|---|
| Language | TypeScript (whole repo) — single language across API + web |
| Repo tooling | npm workspaces monorepo (`apps/*` + `packages/*`) |
| Backend framework | NestJS 11 (modular monolith; guards/modules/DI map to domain boundaries) |
| ORM / DB | Drizzle ORM; SQLite (better-sqlite3) dev/test; PostgreSQL production; one schema, two drivers |
| Validation/API | zod schemas in `domain`/`shared`; NestJS class-validator DTOs; Swagger/OpenAPI at `/api/docs` |
| Jobs | DB-backed job framework in-process now; BullMQ/Redis documented scale-out path |
| Events | In-process domain event bus + persisted audit log now; outbox + Redis Streams later |
| Frontend | React + Vite + Tailwind CSS + TanStack Query + Zustand + React Router |
| Testing | Vitest (unit), NestJS e2e/supertest (integration), Playwright (E2E, later) |
| Deployment | Multi-stage Docker; `docker compose up -d` (api + web + optional postgres); GitHub Actions CI |
| License of this repo | MIT (chosen to permit broad reuse); GPL-derived behavior is reimplemented against public specs, never copied |

See [technology-decisions.md](./technology-decisions.md) for rationale, alternatives, trade-offs and consequences for every
row, and [docs/legal/upstream-licenses.md](../legal/upstream-licenses.md) for the licensing analysis that drove the
language/architecture choice.
