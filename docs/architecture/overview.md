# MediaNexus — Architecture Overview

> Status: **v1.2.0.** This document describes the architecture as built, not a forward-looking plan.

## 1. Purpose

MediaNexus is a single, self-hostable media-automation platform that provides the combined capabilities of **Prowlarr**
(indexers), **Sonarr** (TV) and **Radarr** (movies) through **one coherent application**: one UI, one backend, one domain
model, one auth system, one job/event architecture, one configuration system, one API surface, Docker-first deployment,
and strong interoperability with the surrounding _arr ecosystem. A TMDB-backed discovery view — one of the two
capabilities carried forward from **Seerr** — is shipped; Plex watchlist integration, the other one, is still planned.

This is **not** a skin that embeds the four existing UIs, and it is **not** four cloned apps behind one login. It is a new
codebase with a unified model, where movie and TV automation share infrastructure, and where compatibility with the
existing ecosystem is provided by explicit, isolated adapters.

## 2. Research basis and verified facts

An initial deep-research report scoping Sonarr/Radarr/Prowlarr/Seerr (no longer kept in-repo) was reviewed in full and
used as an *input*, not as unquestionable truth, during the earliest planning of this project. Its claims were verified
against the upstream repositories (licenses, SDK versions, frontend frameworks, package manifests, source layout).
Corrected/confirmed findings:

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
   (Plex/Jellyfin identity + JWT). MediaNexus resolved this by adopting the simpler _arr model only — a single-tier
   `X-Api-Key` — rather than reconciling both (see ADR-010 in `technology-decisions.md`); Seerr's identity model was
   built once for the request workflow and removed along with it.

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
  and a unified quality-profile concept.

## 3. Architecture principles

1. **Modular monolith first.** One deployable backend with strong internal module boundaries; individual domains can be
   extracted later without a rewrite. No premature microservices, no distributed system until the monolith proves it needs
   one.
2. **Unified domain model.** Movies and series share acquisition/quality/download infrastructure where behavior is the
   same; domain differences are preserved where they are real (episode vs movie file import, season monitoring).
3. **API-first.** A documented, versioned `/api/v1` surface is a first-class product for the web UI, mobile, automation,
   and third parties.
4. **Explicit compatibility layer.** Existing-ecosystem APIs (Sonarr/Radarr/Prowlarr) are served by isolated
   adapters that translate into the native domain model; they never dictate internal architecture. (A Seerr-compatible
   surface was built and later removed along with the request/user-accounts workflow it depended on.)
5. **Contract-first integrations.** External systems (indexers, download clients, metadata, media servers, notification
   sinks) implement explicit TypeScript interfaces behind provider registries — never ad-hoc calls scattered in core code.
6. **Docker-first** deployment with persistent volumes, health checks, graceful shutdown, secrets via environment.
7. **Security by default.** API keys, never log or expose credentials, correlation IDs, audit log for admin actions.
8. **Observability from day one.** Structured logs, request IDs, job IDs, health/readiness endpoints, metrics-friendly
   design.
9. **Every major decision is documented** (this directory), **tests accompany meaningful functionality**, and the repo
   stays buildable/runnable at every stage.

## 4. Component architecture

```text
                          ┌──────────────────────┐
                          │   apps/web (React)    │  Vite + Tailwind + TanStack Query + Zustand
                          └──────────┬───────────┘
                                     │  HTTP JSON /api/v1   (+ SSE realtime)
                          ┌──────────▼───────────┐
                          │   apps/api (NestJS)  │  modular monolith: modules per domain
                          └──────────┬───────────┘
       ┌─────────────────────────────┼───────────────────────────────┐
       │              │              │              │                │
 ┌─────▼─────┐  ┌──────▼──────┐  ┌───▼─────┐  ┌─────▼─────┐   ┌──────▼──────┐
 │ media     │  │ discovery   │  │ acquisi-│  │ system    │   │ auth        │
 │ movies/ser│  │ indexers    │  │ tion    │  │ commands  │   │ api keys    │
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
│   ├── api/            NestJS API (modules: system, media, discovery, acquisition, media-servers, auth, jobs, notifications)
│   └── web/            React/Vite UI (dashboard, library, activity, calendar, system shells)
├── packages/
│   ├── domain/         Unified domain model: entity types, zod validation schemas, domain constants
│   ├── database/       Drizzle schema (full intended model), client factory, migrations, seeds
│   ├── integrations/   Provider contracts: Indexer, DownloadClient, Metadata, Notification, MediaServer, Auth, Storage
│   ├── jobs/           DB-backed job framework: definitions, runs, queue, retries, progress
│   ├── events/         Domain event envelope + in-process bus + audit listener
│   ├── compatibility/  Compatibility-layer framework + adapter scaffolding (sonarr/radarr/prowlarr)
│   └── shared/         Config/env schemas, error model, API constants, logger, IDs
├── docs/               architecture / implementation / development / deployment / legal
├── docker/             Dockerfile (single-container image), compose example, env templates
├── scripts/            dev/ops helpers (db migrate, seed, healthcheck, upstream import)
├── .github/            CI workflow
├── docker-compose.yml  top-level `docker compose up -d` (single `app` service)
└── README.md
```

> **Status accuracy:** the scaffold is verified **native** (build, test, run) and the Docker image is verified end-to-end
> (build, boot, `/health/live` + `/health/ready`, SPA, API-key auth) — both locally and via CI's publish-on-tag build.
> Both storage dialects are implemented and tested: SQLite (`better-sqlite3`) is the live default for
> dev/small self-host, chosen from `DATABASE_URL`'s scheme; PostgreSQL (`pg`, `postgres(ql)://`) is fully wired for
> production. The web/web-facing persist path works end-to-end on both (see ADR-004 for the boundary cast, dual sync/async
> transaction bodies, and the SQLite-only backup seam).

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
| Deployment | Multi-stage Docker, single `app` image (API serves the built web UI, no nginx); `docker compose up -d`; GitHub Actions CI publishes the image on tag push |
| License of this repo | MIT (chosen to permit broad reuse); GPL-derived behavior is reimplemented against public specs, never copied |

See [technology-decisions.md](./technology-decisions.md) for rationale, alternatives, trade-offs and consequences for every
row, and [docs/legal/upstream-licenses.md](../legal/upstream-licenses.md) for the licensing analysis that drove the
language/architecture choice.
