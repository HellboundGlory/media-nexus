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

- **API keys:** header `X-Api-Key` with the value's SHA-256 hash looked up in `api_key`. Any valid key is a full-access
  system key, `_arr`-style (like Sonarr/Radarr/Prowlarr's own API-key auth) — there is no login, no per-user accounts, and
  no roles/permission tiers. `Principal` is `{ keyId, isAdmin, scopes }`, and `isAdmin` is always `true` for a valid key.
- **Bootstrap:** on first run, the API mints one system API key and prints it once to logs/startup banner
  (`MEDIA_NEXUS_BOOTSTRAP_KEY` can set it deterministically, e.g. for CI/tests). Default credentials are never hard-coded.
- **Guard policy (security by default):** *all* `/api/v1/*` routes require a valid API key unless explicitly marked
  `@Public()` (health and `/metrics` are the only public areas). The web app stores its key in `localStorage` (injected
  via `VITE_MEDIA_NEXUS_API_KEY` during dev).

## 3. Observability of the API

- **Correlation IDs:** every request gets `X-Request-ID` (per RFC 4122) unless supplied by the client; it flows into logs,
  job runs, audit log and emitted events — the backbone for debugging async flows (Rule of *observability* in `overview`).
- **Structured logs:** JSON lines with `ts, level, msg, requestId, route, status, ms`.
- **Errors:** a consistent `{ error: { code, message, details? } }` envelope; HTTP statuses stay meaningful (400 validation,
  401/403 auth, 404, 409 conflict, 422 semantic, 500 unexpected). Never leak internals or credentials (Rule 7).
- **Health:** `/health/live` (process up) and `/health/ready` (DB reachable + migrations applied). `/api/v1/system/status`
  returns aggregate app info (version, db vendor, uptime).
- **Metrics-ready:** NestJS interceptors log timing; a Prometheus `/metrics` endpoint is a planned (not yet implemented)
  addition — the architecture (guards/interceptors, structured logs) is already metric-friendly.

## 4. Conventions

- **Pagination/filtering:** list endpoints accept `page`/`pageSize` (or `limit`/`offset`) and sortable/filterable fields;
  responses are `{ items, total, page, pageSize }` for lists.
- **Command pattern:** long-running or async operations (e.g. `trigger-job`, later `search-all`, `import`, `rename-all`)
  use an `_arr`-style command endpoint `POST /api/v1/system/commands` that enqueues a job and returns the `jobRun` — a
  single consistent async operation surface (see `jobs.md`).
- **Real-time:** planned Server-Sent Events at `/api/v1/events` (SSE chosen over raw WebSocket for simplicity and HTTP-only
  proxying; the _arr use SignalR — parity considered, SSE + TanStack Query covers the web and compat clients). Not in the
  scaffold; tracked in roadmap.
- **CORS:** not applicable — the web UI is served same-origin by the same process that serves the API; this app is not
  meant to sit behind a separate origin or a public reverse proxy.
- **Rate limiting:** planned for auth endpoints; not in scaffold.

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
schemas live in `packages/domain` and will later generate a typed client for the web (roadmap: OpenAPI → `openapi-typescript`
or similar); the scaffold web app currently keeps hand-written client types in `apps/web/src/api/types.ts` and will migrate
to generated types when the OpenAPI surface stabilizes.
