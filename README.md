# MediaNexus

**Unified media automation platform** — the combined capabilities of **Prowlarr**, **Sonarr**, **Radarr** and **Seerr**
in one coherent, self-hostable application: one UI, one backend, one domain model, one auth system, one job/event
architecture, one API, Docker-first deployment — with an explicit **compatibility layer** so existing _arr ecosystem
clients keep working.

> Status: **M0 scaffold ✅ · M1 real acquisition ✅ · M2 series ✅ · M3 indexers ✅ · M4 requests/users ✅ · M5 notifications/realtime ✅ · M6 compatibility APIs ✅**
> (see [Roadmap](docs/implementation/roadmap.md)).

## Quick start

### Docker

```bash
cp .env.example .env        # then set MEDIA_NEXUS_SECRET (openssl rand -hex 32)
docker compose up -d
# Web UI      → http://localhost:8080
# API docs    → http://localhost:8080/api/docs
# API base    → http://localhost:8080/api/v1
```

The first boot seeds the `admin` user and prints a one-time **API key** to the api logs
(`docker compose logs api`). In Docker, open **System → API key** in the UI and paste that key (stored in the browser);
in local dev you can instead set `VITE_MEDIA_NEXUS_API_KEY` in `apps/web/.env`/`.env.example`.

> Note: Docker is not available in this dev environment; images/compose are authored and CI builds both images before we
> claim "verified in Docker" — local run + tests below are fully verified.

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

## What is implemented (honestly)

- **M1 — Real acquisition.** Newznab/Torznab indexer provider (HTTP, JSON, basic auth, `t=caps` health); SABnzbd (usenet)
  and qBittorrent (torrent, login-cookie) download clients; grab picks a client by protocol+priority; the
  `acquisition.downloadMonitor` job polls clients, mirrors progress into the unified queue, and imports completed
  downloads (locate under downloads root → hardlink→copy into the library with naming templates → `media_file`,
  availability, `ImportCompleted`).
- **M2 — Series.** Episode release parser + matcher (SxxExx, multi-episode packs, "Season X – Episode Y"); episode API
  (list/bulk-create/monitor); Want/Missing + Calendar; episode-mapped import (`Season N/SxxExx`); `media.rssSync` auto-grabs
  missing monitored episodes.
- **M3 — Indexers.** Per-indexer health checks (`/indexers/:id/test` + `discovery.indexerRefresh`), proxy-aware fetch
  (HTTP/HTTPS CONNECT, SOCKS4/5, FlareSolverr), **Cardigann YAML custom definitions** (HTML-scrape + JSON, dynamic settings),
  per-indexer grab statistics.
- **M4 — Requests.** Users + roles (admin/moderator/USER) with scoped API keys and request authz; approval →
  auto-search → auto-grab → **fulfilled** on import; webhook notifications; watchlist + content blocklist; Jellyfin media
  server availability + `media.availabilityRefresh`.
- **M5 — Notifications/realtime/hardening.** Notification sinks for **webhook, Discord, Telegram, Email** (nodemailer),
  per-event subscriptions + test endpoint; **Server-Sent Events** at `/api/v1/events` with UI live-refresh; **Prometheus
  `/metrics`**; **audit trail** endpoint + UI; **rate limiting** on requests/grabs; System page: Users, Notifications, Audit.
- **Foundations (M0).** NestJS API + Vite/React web monorepo, unified Drizzle schema (SQLite; PG planned), native
  `/api/v1`, `X-Api-Key` auth + first-run bootstrap, DB-backed jobs + domain event bus.
- **Compatibility (M6).** Real adapters served under `/api/sonarr/v3`, `/api/radarr/v3` and `/api/prowlarr/v1`:
  Sonarr — series list/get/add/delete, qualityprofile, episode, `command` (maps SeriesSearch/RefreshSeries to native jobs);
  Radarr — movie list/get/add/delete, qualityprofile, command; **Prowlarr — configured indexers + an indexer search proxy**,
  i.e. Sonarr/Radarr can treat MediaNexus as their Prowlarr and search through it. Contract tests lock the wire shapes.

**Not built yet (roadmap):** metadata import (TMDB/TVDB), Plex login/server-user import, Seerr-compatible surface,
full Prowlarr sync (indexer push to Sonarr/Radarr native — the search-proxy read side is done), realtime polish, E2E
(Playwright), Docker-container verification here.

## Repository layout

```text
apps/api                 NestJS API (modules = domain boundaries)
apps/web                 React + Vite + Tailwind UI
packages/domain          Unified domain model (zod schemas, release/episode parsing, quality)
packages/database        Drizzle schema (24 tables), migrations, seeds
packages/events          Domain event envelope + in-process bus + audit listener
packages/jobs            DB-backed job engine (framework-agnostic)
packages/integrations    Provider contracts + real providers (newznab, sabnzbd, qbittorrent, jellyfin, cardigann, proxy)
packages/compatibility   Compatibility-layer framework + sonarr v3 status adapter
packages/shared          Config/env schemas, errors, logger, correlation, IDs, notification configs
docs/                    Architecture, roadmap, development, deployment, legal
docker/                  Dockerfiles, nginx conf
.github/workflows        CI (lint/typecheck/test/build + docker image builds)
```

## Documentation

- Architecture: [overview](docs/architecture/overview.md), [domain model](docs/architecture/domain-model.md),
  [API](docs/architecture/api.md), [jobs](docs/architecture/jobs.md), [events](docs/architecture/events.md),
  [integrations](docs/architecture/integrations.md), [compatibility](docs/architecture/compatibility.md),
  [technology decisions](docs/architecture/technology-decisions.md)
- Roadmap: [docs/implementation/roadmap.md](docs/implementation/roadmap.md)
- Deployment: [docker](docs/deployment/docker.md), [configuration](docs/deployment/configuration.md)
- Legal: [upstream licenses](docs/legal/upstream-licenses.md), [provenance](docs/legal/provenance.md)

## License

MIT. This project **reimplements** the behavior and public APIs of Sonarr/Radarr/Prowlarr (GPL-3.0) against documented
behavior and **does not copy GPL source**; Seerr (MIT) patterns may be adapted with attribution. See
[docs/legal/upstream-licenses.md](docs/legal/upstream-licenses.md).
