# MediaNexus

**Unified media automation platform** — the combined capabilities of **Prowlarr**, **Sonarr**, **Radarr** and **Seerr**
in one coherent, self-hostable application: one UI, one backend, one domain model, one auth system, one job/event
architecture, one API, Docker-first deployment — with an explicit **compatibility layer** so existing _arr ecosystem
clients keep working.

> Status: **foundations + scaffold** (see [Roadmap](docs/implementation/roadmap.md)). The scaffold proves the full
> architecture end-to-end with in-memory demo providers (search → grab → download → import). Real indexer/download
> client providers are milestone **M1**.

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
(`docker compose logs api`). The web app reads the key from `VITE_MEDIA_NEXUS_API_KEY` in `.env` (dev) — in Docker you set
the same key in `.env` so the UI can authenticate.

> Note: Docker is not available in the scaffold's dev environment; images/compose are authored to be CI-validated before
> the claim "verified in Docker" is made. Local run + tests below are fully verified.

### Local development

```bash
npm install
npm run build:backend        # build shared packages + API
npm run db:generate          # (after schema changes) regenerate Drizzle migrations
npm run dev                  # API on :7373 + web on :5173 (swagger at http://localhost:7373/api/docs)
```

Set `MEDIA_NEXUS_BOOTSTRAP_KEY` (and `MEDIA_NEXUS_BOOTSTRAP_ADMIN_PASSWORD`) in the environment to make dev deterministic:
the web UI and API both use that key via `X-Api-Key`.

```bash
npm test                     # packages unit tests + API e2e (temp SQLite)
npm run lint && npm run typecheck
npm run build                # everything
```

See [docs/development/setup.md](docs/development/setup.md) for the full walkthrough.

## What the scaffold does (honestly)

- **Native API `/api/v1`** (OpenAPI at `/api/docs`): `system/status`, `system/config`, `system/commands`, `system/jobs`,
  `movies`, `series`, `indexers`, `search`, `grabs`, `requests`, `history`, `queue`, `auth/whoami`.
- **Auth:** `X-Api-Key` (hashed at rest) + first-run bootstrap admin. All native routes require a key except health.
- **Database:** Drizzle ORM over SQLite (`./data/media-nexus.db`), migrations + static seed (quality profiles, indexer
  definition catalog, job definitions), auto-migrated on boot.
- **Jobs:** DB-backed scheduler + engine (`job_definition` / `job_run`), cron ticker, manual commands, retries/backoff,
  progress, history. `system.healthCheck` runs on schedule; `acquisition.downloadMonitor` drives the demo import pipeline.
- **Events:** typed in-process domain event bus with correlation IDs; `MovieAdded`/`SeriesAdded`/`RequestCreated`/
  `ReleaseGrabbed` etc. are audited; approved requests fire a search job via the event→job bridge (stub until M1).
- **Discovery/Acquisition (demo, in-memory):** configure a demo indexer, search, grab into a demo download client, and
  watch the monitor job "download + import" a movie — proving the full pipeline with test doubles (M1 swaps in real
  Newznab/Torznab + SABnzbd/qBittorrent providers behind the same contracts).
- **Compatibility layer:** `/api/sonarr/v3/system/status` is translated live; remaining Sonarr/Radarr/Prowlarr/Seerr
  surfaces are explicit **501** (not silently fake). See [docs/architecture/compatibility.md](docs/architecture/compatibility.md).
- **Web UI:** dashboard, movies, series, activity, requests, indexers and system pages — dark/light, responsive,
  loading/empty/error states, real API wiring.

Not built yet (roadmap): real provider drivers, TV episode import/monitoring depth, Prowlarr indexer-sync, Seerr
Plex/Jellyfin login, PostgreSQL wiring, notifications+SSE, full compat adapters, E2E.

## Repository layout

```text
apps/api                 NestJS API (modules = domain boundaries)
apps/web                 React + Vite + Tailwind UI
packages/domain          Unified domain model (zod schemas, release/search contracts, quality)
packages/database        Drizzle schema, client factory, migrations, seed
packages/events          Domain event envelope + in-process bus + audit listener
packages/jobs            DB-backed job engine (framework-agnostic)
packages/integrations    Provider contracts (Indexer, DownloadClient, Metadata, MediaServer, Notification, Auth, Storage)
packages/compatibility   Compatibility-layer framework + sonarr v3 status adapter
packages/shared          Config/env schemas, errors, logger, correlation, IDs
docs/                    Architecture, roadmap, development, deployment, legal
docker/                  Dockerfiles, nginx conf
.github/workflows        CI
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
