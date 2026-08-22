# MediaNexus

[![CI](https://github.com/HellboundGlory/media-nexus/actions/workflows/ci.yml/badge.svg)](https://github.com/HellboundGlory/media-nexus/actions/workflows/ci.yml)
[![Docker Image](https://img.shields.io/badge/ghcr.io-v1.6.0-blue?logo=docker&logoColor=white)](https://github.com/users/HellboundGlory/packages/container/package/media-nexus%2Fapp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Unified media automation platform** — the combined capabilities of **Prowlarr**, **Sonarr**, **Radarr**, plus a
narrow slice of **Seerr** (TMDB discover browsing, and eventually Plex watchlist integration — no requests/approvals,
no multi-user accounts), in one coherent, self-hostable application: one UI, one backend, one domain model, one job/event
architecture, one API, Docker-first deployment — with an explicit **compatibility layer** so existing _arr ecosystem
clients keep working. LAN/private-network use only — see [docs/security.md](docs/security.md) before exposing it
anywhere else.

## Quick start

### Docker

```bash
cp .env.example .env        # then set MEDIA_NEXUS_SECRET (openssl rand -hex 32)
docker compose up -d
# Web UI      → http://localhost:7373
# API docs    → http://localhost:7373/api/docs
# API base    → http://localhost:7373/api/v1
```

One container serves both the API and the web UI. Open it and the first screen walks you through **creating your
admin account** (username + password) — no key-copying required. An API key for external tools/scripts is minted on
first boot too, viewable any time from System → API key once you're logged in.

### Local development

```bash
npm install
npm run build:backend        # shared packages + API
npm run dev                  # API on :7373 + web on :5173 (swagger at http://localhost:7373/api/docs)
```

```bash
npm test                     # unit tests (packages) + API e2e (temp SQLite)
npm run lint && npm run typecheck
npm run build                # everything
```

See [docs/development/setup.md](docs/development/setup.md) for the full walkthrough.

## What's implemented

- **Acquisition.** Newznab/Torznab indexers, SABnzbd + qBittorrent download clients, a monitor job that tracks
  downloads and imports completed ones into the library (hardlink/copy + naming templates).
- **Movies & series.** Episode release parsing/matching, Want/Missing + Calendar, quality profiles, RSS auto-grab of
  missing monitored episodes, TMDB movie collections.
- **Indexers.** Per-indexer health checks, proxy-aware fetch (HTTP/HTTPS CONNECT, SOCKS4/5, FlareSolverr), Cardigann
  YAML custom definitions, per-indexer grab statistics.
- **Metadata & Discover.** TMDB-backed search/details/refresh, auto-creates seasons+episodes on import, and a
  Discover page (trending/popular/upcoming/top-rated) with one-click add.
- **Media availability.** Jellyfin/Plex library-availability sync (the seed for a future Plex watchlist integration).
- **Notifications & realtime.** Webhook, Discord, Telegram, and Email sinks with per-event subscriptions;
  Server-Sent Events for live UI updates; Prometheus `/metrics`; an audit trail.
- **Compatibility layer.** Real Sonarr/Radarr/Prowlarr-compatible API adapters, so existing _arr ecosystem clients
  (and Sonarr/Radarr treating MediaNexus as their Prowlarr) keep working.
- **Data migration.** `npm run import:upstream -- --kind <sonarr|radarr|prowlarr> --db /path/to/upstream.db` imports
  a live upstream SQLite database into MediaNexus, idempotently.
- **Auth & hardening.** Single-admin session login (browser) + API key (external/compat clients), credentials
  encrypted at rest, security headers, credential redaction in API responses, Playwright E2E for critical journeys.
- **Storage.** SQLite (default) or PostgreSQL, chosen from `DATABASE_URL`'s scheme — one schema, two drivers.

**Not built yet:** Plex account/watchlist integration, TVDB as a secondary metadata source, full Prowlarr sync
(indexer push to Sonarr/Radarr native — the search-proxy read side is done).

## Repository layout

```text
apps/api                 NestJS API (modules = domain boundaries)
apps/web                 React + Vite + Tailwind UI
packages/domain          Unified domain model (zod schemas, release/episode parsing, quality)
packages/database        Drizzle schema (36 tables), migrations, seeds
packages/events          Domain event envelope + in-process bus + audit listener
packages/jobs            DB-backed job engine (framework-agnostic)
packages/integrations    Provider contracts + real providers (newznab, sabnzbd, qbittorrent, jellyfin, cardigann, proxy)
packages/compatibility   Compatibility-layer framework + sonarr v3 status adapter
packages/shared          Config/env schemas, errors, logger, correlation, IDs, notification configs
docs/                    Architecture, development, deployment, legal
docker/                  Dockerfile, recommended Postgres+Gluetun compose example, env templates
.github/workflows        CI (lint/typecheck/test/build + docker image build)
```

## Documentation

- Architecture: [overview](docs/architecture/overview.md), [domain model](docs/architecture/domain-model.md),
  [API](docs/architecture/api.md), [jobs](docs/architecture/jobs.md), [events](docs/architecture/events.md),
  [integrations](docs/architecture/integrations.md), [compatibility](docs/architecture/compatibility.md),
  [technology decisions](docs/architecture/technology-decisions.md)
- Deployment: [docker](docs/deployment/docker.md), [configuration](docs/deployment/configuration.md),
  [upgrade & migration](docs/deployment/upgrade-and-migration.md)
- Legal: [upstream licenses](docs/legal/upstream-licenses.md), [provenance](docs/legal/provenance.md)

## License

MIT. This project **reimplements** the behavior and public APIs of Sonarr/Radarr/Prowlarr (GPL-3.0) against documented
behavior and **does not copy GPL source**; Seerr (MIT) patterns may be adapted with attribution. See
[docs/legal/upstream-licenses.md](docs/legal/upstream-licenses.md).
