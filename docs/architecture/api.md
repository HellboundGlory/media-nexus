# MediaNexus — API Strategy

## 1. First-class, versioned, documented

The HTTP API is a product, not an implementation detail. It serves the web UI, mobile clients, automation, third-party
apps, the future plugin system, and the compatibility layer.

- **Namespace:** native API lives under **`/api/v1`** (chosen over `v0`/date-versioning: the ecosystem already expects
  `/api/vN` with coexisting major versions, e.g. Sonarr serves v3+v5 simultaneously).
- **Format:** JSON. Request/response bodies are validated by zod (domain packages) and NestJS DTO pipes; both schemas are
  single-sourced via a generator that emits the OpenAPI document.
- **Docs:** Swagger UI served at **`/api/docs`** and OpenAPI JSON at **`/api/docs-json`** (mirrors Seerr's integrated
  docs). Versioned alongside the API.
- **Versioning policy:** additive within a major version; breaking changes require a new major (`/api/v2`), and old majors
  stay served during a documented deprecation window (matches _arr precedent).

## 2. Authentication

Two paths, one trust tier — still no per-user accounts or roles/permission tiers, just two ways to prove you're the
one admin identity:

- **API keys** (external/compat clients, scripts): header `X-Api-Key` with the value's SHA-256 hash looked up in
  `api_key`. `_arr`-style, like Sonarr/Radarr/Prowlarr's own API-key auth. On first run, the API mints one system
  key and prints it once to logs/startup banner (`MEDIA_NEXUS_BOOTSTRAP_KEY` can set it deterministically, e.g. for
  CI/tests); it can be revealed again later (not just at creation) via `GET /api/v1/auth/key`.
- **Session cookie** (the browser): `POST /api/v1/auth/login` (username/password, `admin_credential` table, scrypt)
  issues a signed `httpOnly`, `SameSite=Strict` cookie — no key to copy anywhere. First run is a one-time "create
  your account" screen instead (`POST /api/v1/auth/setup`, only works once).
- Either path resolves to the same `Principal` shape: `{ keyId, isAdmin, scopes }`, `isAdmin` always `true`.
  `ApiKeyGuard` tries the `X-Api-Key` header first, falls back to the session cookie if absent.
- **Guard policy (security by default):** *all* `/api/v1/*` routes require one of the two unless explicitly marked
  `@Public()` (health, `/metrics`, and the login/setup/status endpoints themselves are the public areas).

## 3. Observability of the API

- **Correlation IDs:** every request gets `X-Request-ID` (per RFC 4122) unless supplied by the client; it flows into logs,
  job runs, audit log and emitted events — the backbone for debugging async flows (Rule of *observability* in `overview`).
- **Structured logs:** JSON lines with `ts, level, msg, requestId, route, status, ms`.
- **Errors:** a consistent `{ error: { code, message, details? } }` envelope; HTTP statuses stay meaningful (400 validation,
  401/403 auth, 404, 409 conflict, 422 semantic, 500 unexpected). Never leak internals or credentials (Rule 7).
- **Health:** `/health/live` (process up) and `/health/ready` (DB reachable + migrations applied). `/api/v1/system/status`
  returns aggregate app info (version, db vendor, uptime).
- **Metrics:** a Prometheus `/metrics` endpoint is shipped (`apps/api/src/observability/metrics.{controller,service}.ts`),
  fed by the same NestJS interceptors that log request timing.

## 4. Conventions

- **Pagination/filtering:** list endpoints accept `page`/`pageSize` (or `limit`/`offset`) and sortable/filterable fields;
  responses are `{ items, total, page, pageSize }` for lists.
- **Command pattern:** long-running or async operations (e.g. `trigger-job`, later `search-all`, `import`, `rename-all`)
  use an `_arr`-style command endpoint `POST /api/v1/system/commands` that enqueues a job and returns the `jobRun` — a
  single consistent async operation surface (see `jobs.md`).
- **Real-time:** Server-Sent Events at `GET /api/v1/events`, shipped (SSE chosen over raw WebSocket for simplicity and
  HTTP-only proxying; the _arr use SignalR — parity considered, SSE + TanStack Query covers the web and compat clients).
- **CORS:** not applicable — the web UI is served same-origin by the same process that serves the API; this app is not
  meant to sit behind a separate origin or a public reverse proxy.
- **Rate limiting:** shipped (`apps/api/src/common/rate-limit.guard.ts`, plus a dedicated
  `apps/api/src/auth/login-rate-limit.guard.ts` for login attempts), applied to auth and several other
  write-sensitive endpoints (indexers, blocklist, provider status).

## 5. Native endpoint inventory

Implemented in the scaffold (each listed endpoint exists and is covered by tests unless noted):

| Area | Method + path | Purpose |
|---|---|---|
| Health | `GET /health/live`, `GET /health/ready` | liveness/readiness |
| System | `GET /api/v1/system/status` | app/version/db info |
| System | `GET/PUT /api/v1/system/config` | view/update global settings (admin) |
| System | `POST /api/v1/system/commands/{jobKey}` | trigger a job run manually |
| Movies | `GET /api/v1/movies`, `GET /api/v1/movies/:id`, `POST /api/v1/movies`, `DELETE /api/v1/movies/:id` | movie library CRUD |
| Series | `GET /api/v1/series`, `GET /api/v1/series/:id`, `POST /api/v1/series`, `DELETE /api/v1/series/:id` | series library CRUD |
| Series | `GET /api/v1/series/:id/seasons` | seasons for a series |
| Series | `GET /api/v1/series/:id/episodes`, `POST /api/v1/series/:id/episodes`, `PUT /api/v1/series/:id/episodes/:episodeId` | episode list / bulk-create / monitor toggle (M2) |
| Series | `GET /api/v1/wanted/missing` | monitored episodes without files (Want/Missing) |
| Series | `GET /api/v1/calendar` | upcoming air-dated episodes |
| Auth | `GET /api/v1/auth/whoami` | identity of the API key owner |
| Media servers | `GET/PUT /api/v1/media-servers`, `POST /api/v1/media-servers/refresh`, `POST /api/v1/media-servers/:index/test` | Jellyfin/memory availability sources (seed for future Plex watchlist integration) |
| Realtime | `GET /api/v1/events` | Server-Sent Events stream of domain events (auth via X-Api-Key header) |
| Observability | `GET /metrics` | Prometheus text metrics (public) |
| Observability | `GET /api/v1/system/audit` | recent audit-log entries |
| Notifications | `GET/PUT /api/v1/notifications`, `POST /api/v1/notifications/:kind/:index/test` | webhook/discord/telegram/email config + test delivery |
| Activity | `GET /api/v1/history` | unified history feed |
| Activity | `GET /api/v1/queue` | download queue |
| Indexers | `GET /api/v1/indexers`, `POST /api/v1/indexers` | indexer config (Newznab/Torznab/Cardigann/memory) |
| Indexers | `GET /api/v1/indexers/definitions`, `POST /api/v1/indexers/definitions` | definition catalog + create custom Cardigann definitions |
| Indexers | `POST /api/v1/indexers/:id/test`, `GET /api/v1/indexers/statistics` | live health check (persisted) + per-indexer grab statistics |
| Clients | `GET /api/v1/download-clients`, `POST /api/v1/download-clients`, `DELETE /api/v1/download-clients/:id`, `POST /api/v1/download-clients/:id/test` | download client config + live health check (SABnzbd/qBittorrent/memory) |

### Compatibility surfaces (M6)

| Surface | Implemented routes |
|---|---|
| `GET /api/sonarr/v3/system/status`, `series` (list/get/add/delete), `qualityprofile`, `episode`, `command` | Sonarr v3 read+write |
| `GET /api/radarr/v3/system/status`, `movie` (list/get/add/delete), `qualityprofile`, `command` | Radarr v3 read+write |
| `GET /api/prowlarr/v1/system/status`, `indexer` (list), `indexer/:id/search`, `search` | Prowlarr v1 indexer + search proxy |

`POST /api/v1/search` searches all enabled indexers through their providers (real Newznab/Torznab HTTP); `POST /api/v1/grabs` adds the chosen release to a real SABnzbd/qBittorrent client and mirrors it into the unified queue/history; `acquisition.downloadMonitor` executes the real filesystem import.

Everything above is a *native* endpoint on the unified model. The **compatibility APIs live under their own path
namespace** and are not part of `/api/v1` (see `compatibility.md`).

## 6. API-first implications for the frontend

The web app is a pure API client: no direct DB access, no business logic on the client. Shared contract types and zod
schemas live in `packages/domain`; the web app keeps hand-written client types in `apps/web/src/api/types.ts` today,
with a generated client (OpenAPI → `openapi-typescript` or similar) as a future option if that duplication is ever
worth removing.
