# MediaNexus — Compatibility Layer

## 1. Why a compatibility layer

The ecosystem around the _arrs is large: mobile apps, dashboards (Ombi, Bazarr, request/bot integrations), automation
scripts, and Prowlarr's indexer-sync feature all speak Sonarr's/Radarr's/Prowlarr's REST APIs. Seerr (and its parent
project family) has its own API used by clients. For MediaNexus to *replace* these apps for existing users, it must speak
their APIs — but that must **never** leak into the core domain model or the native API.

Compatibility is a **product feature**, promoted deliberately (Rule 6), delivered by an isolated adapter layer.

## 2. Layering rules

```text
Ecosystem client ──> /api/sonarr/v3 ──► SonarrAdapter (translate request)
                                            │
                                            ├──► MediaNexus domain services (ONE code path)
                                            └──► responses translated back to _arr shapes
```

- The adapter layer (packages/compatibility + apps/api/compat modules) is the **only** place that knows _arr wire formats.
- Native code never returns _arr-shaped payloads unless asked through an adapter.
- Adapters are pure translation: they call the same domain services/Native API internally; no duplicated business logic.
- New native features are not blocked by compat surface and vice-versa.

## 3. What the ecosystem actually depends on

Based on the verified upstream API projects (Sonarr.Api.V3/V5, Radarr.Api.V3, Prowlarr.Api.V1, Seerr's `/api/v1`) and
documented behavior of popular clients:

| Upstream API | Endpoints ecosystem clients rely on | Classification |
|---|---|---|
| Sonarr API v3/v5 | `series` (CRUD), `episode`, `episodefile`, `qualityprofile`, `command` (search/recent/rescan), `queue`, `history`, `wanted`, `calendar`, `system/status`, `health` | **Required** |
| Radarr API v3 | `movie` (CRUD), `movieeditor`, `qualityprofile`, `command`, `queue`, `history`, `wanted`, `system/status` | **Required** |
| Prowlarr API v1 | `indexer` (CRUD), `search` (manual + `t=search` RSS/proxy), health/status, indexer sync endpoints consumed by Sonarr/Radarr, `api/v1/{indexer}/health` | **Required** (esp. indexer sync) |
| Seerr API v1 | `auth/*` (plex/jellyfin login), `request` (create/list/update), `media` (status), `discover`, `search`, `settings/notifications`, watchlist | **High-value** |

A **Required** classification means compatibility is on the critical path for real-world adoption; **High-value** means
large client-bases benefit and it should follow closely; **Optional/obsolete** (e.g. old `Sonarr Api v1`, `Radarr v1/2`)
are explicitly out of scope.

## 4. Routing and namespace

| Surface | Base path |
|---|---|
| Native API | `/api/v1/...` |
| Sonarr-compatible | `/api/sonarr/v3/...` (v5 aliases later) |
| Radarr-compatible | `/api/radarr/v3/...` |
| Prowlarr-compatible | `/api/prowlarr/v1/...` |
| Seerr-compatible | `/api/seerr/v1/...` (Overseerr/Seerr clients) |

`/api/prowlarr/v1/api/v1/...`-style embedded paths (some Prowlarr clients hit nested paths) are handled by the Prowlarr
adapter's router, not by polluting the native router. Auth for compat surfaces: map `X-Api-Key` to MediaNexus API keys
(one wire format, same credential store); Seerr compat additionally accepts its JWT flows when implemented.

## 5. Incremental delivery plan

1. **Contract/document first** — for each target API, capture the exact shape via the project's published OpenAPI/docs and
   encode it in zod contracts + snapshot tests (no code from upstream is copied — shapes are public API facts).
2. **Adapter skeleton** — namespaced routers registered, returning 501 with a documented "not yet implemented" for gaps
   rather than silently pretending.
3. **Read paths first** (`GET series`, `GET qualityprofile`, `GET system/status`) — cheapest and most-used by dashboards.
4. **Write paths next** (`POST series`, `command` search/grab) using the domain services + job system.
5. **Prowlarr sync** — the meatiest piece: emulate Prowlarr's "sync indexer config to Sonarr/Radarr" and the RSS/search
   proxy endpoints that Sonarr/Radarr call to consume indexers from Prowlarr. This *is* the interop most users depend on.

### Compatibility implications of the native model

- `qualityprofile` maps 1:1 to the shared `quality_profile` — trivial win from unification.
- `series`/`movie` maps to native `series`/`movie`; `episodefile`/`movieFile` map to `media_file` rows with
  `mediaType`-aware filtering.
- `command` maps onto the native job system (`system/commands`) — one queue, multiple surfaces.
- `history`/`queue` map onto `history_entry` / `download_queue_entry` (already unified across movies+series).
- Missing/extra fields are translated, never pushed into schema; unknown upstream fields are preserved in a JSON `extra`
  bucket only if the adapter needs round-tripping, defaulting to fail-closed.

## 6. Anti-patterns we reject

- Writing compat endpoints *as* the native API (contaminates domain with _arr shapes).
- Copying upstream controller source (GPL-3.0) — we implement against documented, publicly observable behavior.
- Building every endpoint blindly ("Do not blindly reproduce undocumented APIs"): only Required/High-value surfaces get
  adapters, each with a compatibility contract test.
