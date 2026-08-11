# MediaNexus — Implementation Roadmap

Milestones are ordered by **dependency and risk**. Each milestone is: goal, features, dependencies, tests, acceptance
criteria, upstream references, compatibility implications. Scope/status legend: ✅ done in scaffold, ⏳ next, 🔲 later.

> **Scope reduction (post-M8):** user accounts/login/roles, the request+approval workflow, the personal
> watchlist/content-blocklist, and the `/api/seerr/v1` compatibility surface were **removed** — they are kept in the
> milestone history below for context but are **no longer present**. Auth is now single-tier: any valid `X-Api-Key` is a
> full-access system key, the same trust model as Sonarr/Radarr/Prowlarr's own API-key auth (see
> [technology-decisions.md](../architecture/technology-decisions.md) ADR-010). The Seerr-derived work still in scope:
> a TMDB-backed discover view (**built** — trending/popular/upcoming/top-rated, one-click add) and Plex integration,
> split in two — library-availability sync (**built**, alongside Jellyfin) and account-linked watchlist import
> (**not yet built**). Everything else Seerr-shaped is deliberately out of scope, not a near-term item to restore.
> Demo/in-memory providers (indexer, download client) are kept for test infrastructure only — seeded but filtered out
> of anything a real client browses, and no longer used as a silent fallback when a real client isn't configured.

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

## M1 — Vertical slice: Movies search→grab→download→import→library ✅

**Goal:** the brief's first meaningful slice — proves the full pipeline through *real* external integrations for one domain.

**Features (done)**
- Real `IndexerProvider`: **Newznab/Torznab over HTTP** (JSON search, categories, magnets/nzb links, basic auth, `t=caps` healthcheck).
- Real `DownloadClientProvider`: **SABnzbd** (usenet) and **qBittorrent** (torrent, login-cookie auth) — add/queue/remove/healthcheck.
- Native `POST /api/v1/search` (all enabled indexers) → normalized `release[]` → `POST /api/v1/grabs` (picks a client by
  protocol/priority, records `download_queue_entry` + `history_entry` + events).
- `acquisition.downloadMonitor` job polls every configured client, mirrors progress, and on completion runs the real import
  (locate file under downloads root → hardlink→copy into library root with naming template → `media_file` row, `movie.hasFile`,
  availability=available, `ImportCompleted`).
- Config UI for indexers (Newznab/Torznab) and download clients (SABnzbd/qBittorrent/memory) pages + client health check.

**Dependencies:** M0.

**Tests:** Newznab client against a mock server (contract test on the wire), qBittorrent/SABnzbd against mock APIs,
full pipeline integration test with fake artist + fake client and a test download directory.

**Acceptance criteria (all verified):** add a movie; search a real Newznab indexer returns normalized results (quality sniffed);
grab via SABnzbd/qBittorrent works; import places the file in the library (hardlink verified) and marks the movie available —
proven by `M1: real indexer + download client end-to-end` (mock HTTP indexer + client against real filesystem).  Remaining M1
follow-ups: title-query plus category-first searches across all providers, per-provider QoS/retry, and deeper per-downloader import heuristics.

**Upstream references:** Sonarr/Radarr manual-search & grab semantics; newznab.readthedocs.io; qBittorrent Web API; SABnzbd
API docs.

**Compatibility implications:** first compat targets (read paths `GET series`, `GET movie`, `system/status`) can begin in
parallel; Prowlarr-style `search?t=...` proxy becomes reachable once Newznab search exists.

## M2 — Series domain equivalence ✅

**Goal:** TV parity with movies: seasons, episodes, monitoring, episode files, Want/Missing, calendar, RSS auto-grab.

**Features (done):**
- Episode release parser + matcher (SxxExx, multi-episode `-E17`/`E17`, "Season X - Episode Y"; article-tolerant series-name matching) in `packages/domain`.
- Episode API: list per season, bulk-create, monitor toggle; `GET /api/v1/wanted/missing`; `GET /api/v1/calendar`.
- **Series grab + episode-mapped import:** `Series/Season N/SxxExx` naming, `media_file.episodeIds`, `episode.hasFile`,
  availability = available when all monitored episodes have files, else partially_available.
- **`media.rssSync` auto-grab job:** searches monitored missing episodes with an SxxExx tag, filters by exact SxxExx +
  series name, picks best quality (then seeders), auto-grabs — duplicate-safe (active-queue + recent-grab guards), bounded per run.
- Web: series detail page (episode grid, monitor toggles, per-episode search & grab, one-click RSS sync), Wanted tab in
  Activity, Calendar page.

**Tests:** episode parser/matcher units; M2 e2e — series + episodes, `media.rssSync` auto-grabs S01E01 from a mock Newznab,
mutates through a mock SABnzbd, imports into a real filesystem as `Season 1/...S01E01...`, Wanted drops to the still-missing
S01E02, Calendar lists the upcoming episode, monitor toggle removes from Wanted. (59 tests green total.)

**Acceptance criteria (verified):** a monitored series automatically RSS-grabs a missing episode and imports it.

**Remaining M2 follow-ups:** season-pass UX, shared quality-profile editor (movies+TV), scene-numbering + anime absolute
episode handling, per-downloader import-layout heuristics, and TMDB/TVDB metadata import to auto-populate episodes.

**Compatibility implications:** Sonarr `series/episode/episodefile/wanted/calendar` read surfaces have native equivalents.

## M3 — Indexer management (Prowlarr parity) ✅

**Goal:** indexer catalog + configuration + health + proxy + manual search archive.

**Features (done):** real per-indexer health checks (`POST /indexers/:id/test` + `discovery.indexerRefresh` job that
persists status/lastError and emits `IndexerFailed`); **proxy-aware fetch** (`buildFetcher`): HTTP/HTTPS CONNECT, SOCKS4/5,
FlareSolverr challenge bypass, wired into newznab/torznab/cardigann providers; **Cardigann subset interpreter**
(settings-driven forms, `${...}` substitutions, cheerio HTML scrape + JSON mode) with `POST /indexers/definitions` to create
custom definitions; per-indexer **grab statistics**; manual search across all indexers (verified with a custom Cardigann indexer
in e2e); UI (health test buttons, dynamic Cardigann settings forms, stats, custom-definition form).

**Dependencies:** M1 (search infra), M0 (indexer tables).

**Tests:** config zod schemas, Cardigann interpreter against fixture YAML, health check job.

**Acceptance criteria (verified):** add/configure/test indexers end-to-end (ok + failing healthcases persist status);
search across Newznab + Cardigann + memory indexers aggregates results with per-indexer attribution.

**Not in this milestone (punted, honest):** Prowlarr **indexer-sync compatibility** surfaces ship with the compat layer (M6),
not here; full Cardigann engine breadth (many tracker defs will need per-definition extensions — flagged); categories editor
(reads via definition catalog already, full editor + proxy/FlareSolverr global UI pending).

**Compatibility implications:** Prowlarr `indexer` CRUD + **indexer sync to Sonarr/Radarr/Prowlarr surfaces** lands here —
this is the highest-value interop for existing users.

## M4 — Requests module (Seerr parity) ✅, later **removed**

**Goal (as originally built):** full request lifecycle with users: request → approval → auto-search → availability.

**Features (done, then removed):** user accounts + roles (admin/moderator/USER) with scoped API keys and request authz;
`request_item` season granularity; approval → auto-search → auto-grab (`media.searchForRequest`, movies + series);
request lifecycle `pending → approved → processing → fulfilled/failed`; webhook notifications for request/import events;
watchlist + content blocklist (principal-scoped); restricted users submitting + seeing only their own requests. All of
the above — user accounts/login/roles, the request+approval workflow, and the personal watchlist/content-blocklist —
was **deliberately removed** in a later cleanup (see the scope-reduction note at the top of this file); the `user`,
`request`, `request_item`, `watchlist` and `user_content_blocklist` tables are gone (migration
`0003_drop_seerr_tables.sql`).

**Kept:** the **Jellyfin media-server provider** (HTTP API) + `media.availabilityRefresh` job survived the cleanup —
moved to its own `apps/api/src/media-servers/` module, functionally unchanged. A **Plex media-server provider**
(library-availability sync, same contract) was added alongside it. Account-linked **Plex watchlist** import remains
**not yet built** — a separate, bigger feature (plex.tv OAuth/account linking) than local-server library sync.

**Compatibility implications:** none currently — the Seerr-compatible read+write surfaces (`request`, `media`,
`discover`, `auth/*`) that were delivered in M6b were removed along with this milestone's tables.

## M5 — Notifications, realtime, hardening

**Goal:** completion of cross-cutting infrastructure.

**Features:** NotificationProvider implementations (webhook, email, Discord/Slack/Telegram), subscription per event+topic,
SSE event stream for UI realtime, audit UI, metrics endpoint (Prometheus), rate limiting.

**Dependencies:** M0 events/bus; M4 events to notify on.

**Tests:** webhook delivery contract tests, SSE integration, notification routing.

**Acceptance criteria:** a webhook receives `ReleaseGrabbed`; the UI reflects queue/download changes via SSE.

**Compatibility implications:** none (pure native capability) but enables future webhook-compat surfaces.

## M6 — Compatibility APIs ✅

**M6 (done):** Sonarr v3 + Radarr v3 + Prowlarr v1 surfaces live under their own namespaces
(`/api/sonarr/v3`, `/api/radarr/v3`, `/api/prowlarr/v1`), translated from native services — series/movie read+write,
quality profiles, episodes, `command` (maps to native jobs: SeriesSearch/MoviesSearch → rssSync, RefreshSales → indexer
refresh), Prowlarr indexer list + **search proxy** (so Sonarr/Radarr can use MediaNexus-as-Prowlarr and search through it).
Compatibility **contract tests** (packages/compatibility) lock the upstream wire shapes; an e2e adds/lists a series via
`/api/sonarr/v3/series`, adds/lists a movie via `/api/radarr/v3/movie`, and searches via the Prowlarr proxy.
Remaining (as of M6): Seerr-compatible surface (next, delivered in M6b and later removed — see M6b/M4 below), Prowlarr
push-sync to native *_arr apps, deeper Sonarr v5/Radarr v4 parity.

**Goal:** existing ecosystem clients work against MediaNexus.

**Features:** adapters per `compatibility.md`; read paths first, then `command` search/grab, then Prowlarr indexer-sync
proxy. Compatibility **contract tests** against recorded upstream behaviors (mocked wire fixtures).

**Dependencies:** M1–M4 native capabilities (adapters call the same domain services).

**Tests:** contract tests with fixtures for each surface (request/response locked to upstream-documented shapes).

**Acceptance criteria:** a real ecosystem client (e.g. a Sonarr-compatible mobile app or a dashboard) can add/list a series
against MediaNexus; Sonarr can add MediaNexus-as-Prowlarr indexer and search through it.

**Compatibility implications:** this milestone *is* the compatibility surface; native API untouched.

## M6b — Seerr-compatible surface ✅ (later **removed**) + Metadata import (TMDB) ✅

- **Seerr surface (`/api/seerr/v1`), removed:** originally shipped status, `auth/local` login, `auth/me`, `auth/logout`,
  requests list + create, `media/:tmdbId`, `discover/movies|tv`, `search`, `settings/public`. It was removed along with
  the request/user-accounts workflow it depended on. Worth noting even while it existed it never actually queried TMDB —
  `discover`/`search` just dressed up the local library as fake results. It is not on the roadmap to restore; see the
  scope-reduction note at the top of this file for what Seerr-derived work is still planned.
- **Metadata import (TMDB), kept and unaffected by the removal:** TMDB provider (search / details / `tv/:id/season/:n`
  episodes, `find` for tvdb↔tmdb); settings `metadata.tmdbApiKey`/`metadata.tmdbBaseUrl` (System → Metadata in the UI);
  `POST /series/:id/metadata` **auto-creates seasons + episodes**, `POST /movies/:id/metadata` enriches
  overview/genres/releaseDate, `GET /metadata/search`, and a `media.metadataRefresh` job; UI buttons (Series detail
  "Import from TMDB", Movies refresh). Verified with a mock TMDB e2e (series gains S01E01 "Pilot" with air date; movie
  gets overview/genres).
- **Discover ✅ (built on the above):** `GET /api/v1/discover` (trending/popular/upcoming/top_rated, movie or series)
  flags results already in the library; `POST /api/v1/discover/add` one-click adds a title, resolving TMDB↔TVDB ids
  for series and best-effort enriching via the same metadata-refresh path used above. Web UI: a **Discover** page
  (tabs, category pills, poster grid, Add/In-library state). `series` gained a secondary `tmdbId` column (identity
  stays `tvdbId`) purely so Discover can match "already in library" cheaply.

## M7 — Data migration from live apps

**M7 (done):** a migration tool reads live upstream SQLite databases and maps them into the unified
model:
- **Sonarr** — series, seasons, episodes (monitoring/air-dates), quality profiles, history (EventType→action), indexers
- **Radarr** — movies, quality profiles, history, indexers
- **Prowlarr** — indexers (settings JSON passthrough)

A Seerr/Overseerr importer (`--kind seerr` — users, requests, watchlists) originally existed here too; it was removed
along with the user-accounts/request/watchlist tables it fed (see the scope-reduction note at the top of this file).
`--kind` now accepts only `sonarr|radarr|prowlarr`.

Idempotent via upstream-id-derived keys; reports per-entity counts + un-mapped rows. CLI `npm run import:upstream --
--kind <x> --db <upstream.db> [--target <media-nexus.db>]` plus a programmatic `runImport`; Postgres-exports migration
and a web-UI migration wizard are follow-ups. Verified: fixture DBs for Sonarr/Radarr/Prowlarr + CLI smoke + idempotency.

**Goal:** users migrate existing Sonarr/Radarr/Prowlarr installs without data loss.

**Features:** CLI import from SQLite/Postgres exports (or live API) mapping upstream entities → unified model; idempotent
re-run; report of un-imported data.

**Dependencies:** M6 (to validate against real import semantics along the way).

**Tests:** fixture databases from each upstream → assertions on resulting unified rows.

**Acceptance criteria:** importing a real Sonarr DB preserves series, monitoring, quality profiles, history (mapped),
indexer configs.

## M8 — Release hardening

**M8 (done):** security hardening (redact credentials in native API responses for indexers/
download-clients/config/media-servers; admin-gate config-PUT + metadata refresh; security response headers middleware),
a security doc (`docs/security.md` + authz matrix + hardening checklist), a CI publish-on-tag GHCR job (single unified
image), and an upgrade/migration runbook. `POST /api/v1/auth/regenerate-key` rotates the calling key (mint-then-delete,
no lockout window) with a Copy/Regenerate UI in System settings — the "refreshable/rotatable API keys" follow-up below
is now **done**; scope enforcement beyond `*` remains unbuilt (single-tier auth has no narrower scopes yet). Playwright
browser E2E exists (`apps/web/e2e`, run locally via `npm run test:e2e`) but is no longer a CI job — it was flaky/
non-blocking there and got removed rather than kept as noise; everything else is CI-gated (lint/typecheck/test) or
locally verified. Remaining follow-ups: Postgres support, load-smoke/performance pass, Docker-container verification
in this dev environment. (JWT/Plex login sessions are no longer planned — auth is deliberately single-tier API-key
now, see ADR-010; a future Plex integration is scoped as watchlist sync, not login.)

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
