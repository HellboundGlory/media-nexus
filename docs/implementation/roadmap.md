# MediaNexus — Implementation Roadmap

Milestones are ordered by **dependency and risk**. Each milestone is: goal, features, dependencies, tests, acceptance
criteria, upstream references, compatibility implications. Scope/status legend: ✅ done in scaffold, ⏳ next, 🔲 later.

---

## M0 — Foundations & scaffold ✅ (this milestone)

**Goal:** prove the architecture end-to-end: one repo that builds, runs natively and in Docker, exposes health + an
initial native API, connects to a database with migrations, runs scheduled jobs, emits domain events into an audit log,
serves a frontend that talks to the API, has automated tests and CI.

**Features**
- Monorepo (npm workspaces): `apps/api` (NestJS), `apps/web` (Vite+React+Tailwind), `packages/{domain,database,
  integrations,jobs,events,compatibility,shared}`.
- Unified Drizzle schema (SQLite+Postgres drivers); migration + seed pipeline.
- `/health/live`, `/health/ready`, `/api/v1/system/status`, settings config, whoami.
- Movies & Series CRUD + seasons; unified `history_entry`/`download_queue_entry` reads.
- API-key auth guard; bootstrap admin + one-time API key on first run.
- DB-backed job system + `system.healthCheck` scheduled job; manual `POST /system/commands/:jobKey`.
- Domain event bus; `MovieAdded`/`SeriesAdded`/`RequestCreated` → audit log; request create → event-to-job stub.
- Requests domain (`request` + `media_availability`) minimal create/list.
- Web shell: dashboard + movies + series + activity pages, dark/light, loading/empty/error states, API wire-up.
- Dockerfile + compose (api/web/postgres-optional), healthchecks, non-root, volumes.
- CI (GitHub Actions): install → typecheck → lint → test → build.

**Dependencies:** none (greenfield).

**Tests:** unit (packages), integration/e2e (API), web build + smoke test in CI.

**Acceptance criteria:** `npm install && npm test` passes; `npm run dev` serves API+web; `npm run build` produces
artifacts; docker compose config validates.

**Upstream references:** verified facts table in `docs/architecture/overview.md`.

**Compatibility implications:** none yet (native API only); compatible surfaces are stubbed with explicit 501s.

## M1 — Vertical slice: Movies search→grab→download→import→library ⏳ (recommended next)

**Goal:** the brief's first meaningful slice — proves the full pipeline through *real* external integrations for one domain.

**Features**
- First real `IndexerProvider`: **Newznab/Torznab over HTTP** (search, categories, nzb/magnet download link).
- First real `DownloadClientProvider`: **qBittorrent** and/or **SABnzbd** (add, queue, status).
- `POST /api/v1/movies/search` → `GET /api/v1/search/{movieId}` native search flow returning normalized `release[]` →
  `POST /grabs` (grab → enqueue download via client, record `history_entry` + `download_queue_entry`).
- Download watcher job (`acquisition.downloadMonitor`) → complete → import pipeline (verify, quality, hardlink/copy into
  library) → `MovieCompletedImport`, `media_file` row, `movie.hasFile`.
- Config UI for indexer + download client from zod schemas.

**Dependencies:** M0.

**Tests:** Newznab client against a mock server (contract test on the wire), qBittorrent/SABnzbd against mock APIs,
full pipeline integration test with fake artist + fake client and a test download directory.

**Acceptance criteria:** adding a movie, searching a real indexer returns results; grabbing a real result downloads via a
real configured client; import places a file and marks the movie available — all driven by the web UI and API.

**Upstream references:** Sonarr/Radarr manual-search & grab semantics; newznab.readthedocs.io; qBittorrent Web API; SABnzbd
API docs.

**Compatibility implications:** first compat targets (read paths `GET series`, `GET movie`, `system/status`) can begin in
parallel; Prowlarr-style `search?t=...` proxy becomes reachable once Newznab search exists.

## M2 — Series domain equivalence

**Goal:** TV parity with movies: seasons, episodes, monitoring, episode files, season-pass, calendar.

**Features:** series detail (seasons/episodes grid), per-episode monitoring, episode import (multi-episode packs),
Want/Missing list, calendar, RSS sync job (`media.rssSync`) for automated grabs, quality profile editor shared with movies,
episode search.

**Dependencies:** M1 (search/grab/import primitive reuse).

**Tests:** episode parser/matching unit tests (release title → episode mapping), RSS sync integration.

**Acceptance criteria:** a monitored series automatically RSS-grabs a new episode matching its profile and imports it.

**Upstream references:** Sonarr monitoring/scene-numbering behavior, episode file matching.

**Compatibility implications:** Sonarr `series/episode/episodefile/wanted/calendar` read+write surfaces here.

## M3 — Indexer management (Prowlarr parity)

**Goal:** indexer catalog + configuration + health + proxy + manual search archive.

**Features:** definition catalog UI (Newznab/Torznab), Cardigann YAML custom definitions (format interpreter), per-indexer
proxy (HTTP/SOCKS5 + FlareSolverr), health/status checks + alerts, indexer history/stats, manual search accross indexers,
categories editor.

**Dependencies:** M1 (search infra), M0 (indexer tables).

**Tests:** config zod schemas, Cardigann interpreter against fixture YAML, health check job.

**Acceptance criteria:** add/configure/test an indexer end-to-end; search across multiple indexers aggregates results.

**Compatibility implications:** Prowlarr `indexer` CRUD + **indexer sync to Sonarr/Radarr/Prowlarr surfaces** lands here —
this is the highest-value interop for existing users.

## M4 — Requests module (Seerr parity)

**Goal:** full request lifecycle with users: request → approval → auto-search → availability.

**Features:** user accounts + roles/permissions, Plex/Jellyfin login + user import, request creation/approval/denial,
`request_item` season granularity, watchlist + content blocklist, availability watchers (media servers), notifications on
state change.

**Dependencies:** M1 (search/grab), M0 (request tables), media-server provider (first: Jellyfin/Plex).

**Tests:** approval state machine, request→search event-to-job mapping, permission tests.

**Acceptance criteria:** a restricted user can submit a request; an approver approves; the system auto-searches and grabs;
the requester gets a notification when available.

**Compatibility implications:** Seerr-compatible read+write surfaces (`request`, `media`, `discover`, `auth/*`).

## M5 — Notifications, realtime, hardening

**Goal:** completion of cross-cutting infrastructure.

**Features:** NotificationProvider implementations (webhook, email, Discord/Slack/Telegram), subscription per event+topic,
SSE event stream for UI realtime, audit UI, metrics endpoint (Prometheus), rate limiting.

**Dependencies:** M0 events/bus; M4 events to notify on.

**Tests:** webhook delivery contract tests, SSE integration, notification routing.

**Acceptance criteria:** a webhook receives `ReleaseGrabbed`; the UI reflects queue/download changes via SSE.

**Compatibility implications:** none (pure native capability) but enables future webhook-compat surfaces.

## M6 — Compatibility APIs (Sonarr/Radarr/Prowlarr/Seerr adapters)

**Goal:** existing ecosystem clients work against MediaNexus.

**Features:** adapters per `compatibility.md`; read paths first, then `command` search/grab, then Prowlarr indexer-sync
proxy. Compatibility **contract tests** against recorded upstream behaviors (mocked wire fixtures).

**Dependencies:** M1–M4 native capabilities (adapters call the same domain services).

**Tests:** contract tests with fixtures for each surface (request/response locked to upstream-documented shapes).

**Acceptance criteria:** a real ecosystem client (e.g. a Sonarr-compatible mobile app or a dashboard) can add/list a series
against MediaNexus; Sonarr can add MediaNexus-as-Prowlarr indexer and search through it.

**Compatibility implications:** this milestone *is* the compatibility surface; native API untouched.

## M7 — Data migration from live apps

**Goal:** users migrate existing Sonarr/Radarr/Prowlarr/Seerr installs without data loss.

**Features:** CLI import from SQLite/Postgres exports (or live API) mapping upstream entities → unified model; idempotent
re-run; report of un-imported data.

**Dependencies:** M6 (to validate against real import semantics along the way).

**Tests:** fixture databases from each upstream → assertions on resulting unified rows.

**Acceptance criteria:** importing a real Sonarr DB preserves series, monitoring, quality profiles, history (mapped),
indexer configs; importing Seerr preserves users, requests, watchlists.

## M8 — Release hardening

**Goal:** production-ready distribution.

**Features:** full docs pass, E2E (Playwright) on critical journeys, security review (authz, secrets, proxy headers),
Docker image publishing + CI/CD, upgrade/migration runbooks, localization-ready scaffolding, performance pass.

**Dependencies:** everything prior.

**Tests:** E2E journeys, load smoke.

**Acceptance criteria:** documented path from fresh install → configured indexers+clients → media flowing; CI publishes
images on tag.

---

## Cross-cutting notes

- **Risk register (top):** 1) feature-regression vs upstream edge cases (mitigate: behavior-focused unit tests per domain,
  contract fixtures); 2) data-migration fidelity (M7, appends-only mapping, dry-run reports); 3) single-process concurrency
  ceiling for jobs (mitigate: claim leases + documented Redis scale-out); 4) Cardigann completeness (format interop is
  large; scope v1 to common trackers, extend later); 5) Docker correctness (Docker unavailable in dev env — validate via
  CI container build before shipping).
- **Testing strategy:** `docs/development/testing.md` defines layers (unit/integration/contract/E2E) and the priority
  workflows per the brief; M1+ adds live-harness integration tests.
