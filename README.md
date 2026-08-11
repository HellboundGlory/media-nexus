# MediaNexus

**Unified media automation platform** — the combined capabilities of **Prowlarr**, **Sonarr**, **Radarr**, plus a
narrow slice of **Seerr** (TMDB discover browsing, and eventually Plex watchlist integration — no requests/approvals,
no user accounts/login), in one coherent, self-hostable application: one UI, one backend, one domain model, one job/event
architecture, one API, Docker-first deployment — with an explicit **compatibility layer** so existing _arr ecosystem
clients keep working.

> **Not public-facing.** This app is meant for LAN/private-network use only. There are no user accounts and no
> login — a single system API key grants full access. Never put it behind a public reverse proxy or expose it to
> the internet.

> Status: **M0–M7 ✅ (acquisition · series · indexers · notifications/realtime · compatibility · metadata · migration) · M8 hardening ✅**
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

One container serves both the API and the web UI. The first boot mints a one-time **system API key** and prints it
to the logs (`docker compose logs app`). Open **System → API key** in the UI and paste that key (stored in the
browser); in local dev you can instead set `VITE_MEDIA_NEXUS_API_KEY` in `apps/web/.env`/`.env.example`.

> Note: Docker is not available in this dev environment; the image is authored and CI builds it before we claim
> "verified in Docker" — local run + tests below are fully verified.

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
- **M4 — Media availability.** Jellyfin/media-server library availability sync + `media.availabilityRefresh`
  (the seed for future Plex watchlist integration — see roadmap).
- **M5 — Notifications/realtime/hardening.** Notification sinks for **webhook, Discord, Telegram, Email** (nodemailer)
  on grab/import/indexer-failure/download-client-failure events, per-event subscriptions + test endpoint; **Server-Sent
  Events** at `/api/v1/events` with UI live-refresh; **Prometheus `/metrics`**; **audit trail** endpoint + UI (movie/series
  add/remove, manual job runs); System page: Notifications, Audit.
- **Foundations (M0).** NestJS API + Vite/React web monorepo, unified Drizzle schema (SQLite; PG planned), native
  `/api/v1`, single-tier `X-Api-Key` auth + first-run bootstrap (no user accounts/login), DB-backed jobs + domain event bus.
- **Compatibility (M6).** Real adapters under `/api/sonarr/v3`, `/api/radarr/v3`, `/api/prowlarr/v1`:
  Sonarr — series list/get/add/delete, qualityprofile, episode, `command` (maps SeriesSearch/RefreshSeries to native jobs);
  Radarr — movie list/get/add/delete, qualityprofile, command; **Prowlarr — configured indexers + an indexer search proxy**,
  i.e. Sonarr/Radarr can treat MediaNexus as their Prowlarr and search through it. Contract tests lock the wire shapes.
- **Data migration (M7).** `npm run import:upstream -- --kind <sonarr|radarr|prowlarr> --db /path/to/upstream.db`
  (auto-detects kind; `--target` optional). Reads live upstream SQLite databases and maps them into the unified model —
  series/seasons/episodes/monitoring, movies, quality profiles, history, indexers (settings) — idempotently (derived ids;
  re-running just skips). Emits an import report (counts + un-mapped rows). Verified against fixture DBs for all three
  upstreams.
- **Metadata (TMDB).** `metadata.tmdbApiKey` + `metadata.tmdbBaseUrl` (System → Metadata in the UI); TMDB provider
  (search / details / series seasons+episodes / trending+popular+upcoming+top-rated discover lists);
  `POST /api/v1/series/:id/metadata` **auto-creates seasons + episodes** (M2 no longer needs manual seeding),
  `POST /api/v1/movies/:id/metadata` enriches overview/genres/releaseDate, `GET /api/v1/metadata/search` finds
  candidates, `media.metadataRefresh` job, and UI buttons (Series detail "Import from TMDB", Movies refresh).
- **Discover.** `GET /api/v1/discover` (trending/popular/upcoming/top-rated, movies or TV, TMDB-backed) flags results
  already in the library; `POST /api/v1/discover/add` one-click adds a title (resolving TMDB↔TVDB ids for series) and
  best-effort enriches it via the same metadata-refresh path. Web UI: **Discover** page with media-type tabs, category
  pills, a poster grid, and "Add to library" / "In library" per title.

- **Hardening (M8):** security headers, credential redaction in native API responses, admin-gated config/metadata, **Playwright browser E2E** for critical journeys (config + spec + CI job), **CI publish-on-tag** (GHCR image push on `v*` tags), plus `docs/security.md` and an upgrade/migration runbook.

**Not built yet (roadmap):** Plex account/watchlist integration (the other piece of Seerr this project wants — the
`media-servers` module is the intended seed for it), Postgres-exports migration (currently SQLite upstreams), TVDB as a
secondary metadata source, full Prowlarr sync (indexer push to Sonarr/Radarr native — the search-proxy read side is
done), realtime polish, Docker-container verification here.

## Repository layout

```text
apps/api                 NestJS API (modules = domain boundaries)
apps/web                 React + Vite + Tailwind UI
packages/domain          Unified domain model (zod schemas, release/episode parsing, quality)
packages/database        Drizzle schema (19 tables), migrations, seeds
packages/events          Domain event envelope + in-process bus + audit listener
packages/jobs            DB-backed job engine (framework-agnostic)
packages/integrations    Provider contracts + real providers (newznab, sabnzbd, qbittorrent, jellyfin, cardigann, proxy)
packages/compatibility   Compatibility-layer framework + sonarr v3 status adapter
packages/shared          Config/env schemas, errors, logger, correlation, IDs, notification configs
docs/                    Architecture, roadmap, development, deployment, legal
docker/                  Single Dockerfile (API serves the built web UI — no nginx/web container)
.github/workflows        CI (lint/typecheck/test/build + docker image build)
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
