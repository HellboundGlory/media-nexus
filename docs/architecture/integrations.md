# MediaNexus — Integrations Architecture

## 1. Principle: contract-first, pluggable

External systems — indexers, download clients, metadata providers, media servers, notification sinks, auth providers —
are reached **only through explicit provider contracts** defined in `packages/integrations`. Core domain services depend on
contracts (interfaces + zod schemas for configuration), never on a specific vendor.

Each provider implementation = three things:

1. **Metadata/identity** — `key`, `name`, `protocol`/`kind`, `schemaVersion`
2. **Configuration schema** (zod) — used to validate stored `settings` JSON and to generate the settings UI
3. **Capabilities** — the methods that provider officially supports (e.g. `search`, `download`, `healthcheck`)

```text
core service ──> ProviderRegistry ──> { Indexer | DownloadClient | MetadataProvider | ... } contract
                                            │
                                            └──> concrete implementation (registered by key)
```

Registration is declarative (a module of providers per kind); adding a new vendor does **not** touch core logic
(Rule: "integration should implement a known capability rather than become coupled to the whole app").

## 2. Provider contracts (TypeScript interfaces in `packages/integrations`)

Implemented as interfaces + zod config schemas (interfaces are real and unit-tested; concrete vendor drivers are added
as needed):

| Contract | Key method(s) | Ecosystem analogues |
|---|---|---|
| `IndexerProvider` | `search(query, caps)` → `Release[]`; `healthcheck()` | Newznab (usenet), Torznab (torrents), Cardigann YAML definitions (Prowlarr) |
| `DownloadClientProvider` | `addRequest(release)`, `getQueue()`, `remove(id)`, `progress` | SABnzbd, NZBGet, qBittorrent, Transmission, Deluge, rTorrent, … |
| `MetadataProvider` | `searchMedia`, `getDetails(mediaType, id)` → normalized metadata | TMDB, TheTVDB, OMDb, Trakt |
| `MediaServerProvider` | `scanLibrary`, `importUserList`, `getAvailability`, `refreshMetadata` | Plex, Jellyfin, Emby |
| `NotificationProvider` | `notify(event, ctx)` → delivered | Webhook, email (nodemailer), Discord, Slack, Telegram, Pushover, … |
| `AuthProvider` | `authenticate(exchange)` → user identity | Plex OAuth, Jellyfin, local password |
| `StorageProvider` | walk/move/copy/hardlink/delete library files | local filesystem (native), SMB/NFS (later) |

Configuration schemas (e.g. `sabnzbdSettingsSchema`, `qbittorrentSettingsSchema`, `newznabSettingsSchema`,
`torznabSettingsSchema`) are defined with zod in `packages/integrations/src/schemas` so `indexer.settings` and
`download_client.settings` columns are validated at write time.

## 3. Indexer protocols — the discovery backbone

- **Newznab** (usenet): XML-RSS API (`?t=search&q=...&apikey=...`), categories, `nzb` downloads. Public spec
  (newznab.readthedocs.io) — reimplemented against the documented protocol, not copied from Prowlarr's GPL code.
- **Torznab** (torrents): Newznab extension adding torrent categories (2000s) + `torznab` capabilities. Also public spec.
- **Cardigann** (Prowlarr): YAML templates for tracker sites with no standard API. A **subset interpreter is implemented**
  (`packages/integrations/src/cardigann.ts`): settings-driven forms, search paths with `${...}` substitution, HTML scraping
  via cheerio selectors and a JSON mode. The *format* is reimplemented — never Prowlarr's parser code (see `legal/upstream-licenses.md`).
- **Proxy support:** per-indexer HTTP/HTTPS CONNECT + SOCKS4/5 (via http(s)-proxy-agent / socks-proxy-agent) and **FlareSolverr**
  challenge bypass — routed through a proxy-aware fetch builder (`buildFetcher`) so every provider benefits.
- **Health/sync:** periodic `healthcheck()` per indexer writes `indexer.status`; Prowlarr-style "sync indexers to other
  apps" becomes part of the compatibility layer (it is an interop feature, not a core one — see `compatibility.md`).

## 4. Download client protocols

- Usenet: SABnzbd HTTP API (`api?mode=addurl&name=nzb`), NZBGet JSON-RPC.
- Torrent: qBittorrent Web API (`/api/v2/torrents/add`), Transmission RPC, Deluge, rTorrent/RuTorrent.
- The `DownloadClientProvider` contract normalizes these into `addRequest → downloadId`, `getQueue(status/progress)`,
  `remove(id, deleteData)`, `healthcheck`. The unified `download_queue_entry` mirrors whatever client the headless
  workers drive; no per-client code lives in core.

## 5. Metadata, media servers, notifications

- **Metadata:** TMDB is the primary metadata source for movies *and* series (Seerr's model; TheTVDB retained as secondary
  for TV identity). Normalization into `movie`/`series`/`collection`/`person` rows is a `MetadataProvider` responsibility.
- **Media servers:** **Jellyfin** (`Items`/`Users`/`System/Info`) and **Plex** (`/library/sections` +
  `/library/sections/:key/all`, `X-Plex-Token` auth) over HTTP, both for library scan + availability by TMDB/TVDB
  provider ids. The `media_availability` table is the seam; `media.availabilityRefresh` syncs it. Emby is planned on
  the same contract. Plex here is library-availability only — account-linked Plex watchlist import is separate,
  still-planned scope.
- **Notifications:** a `NotificationProvider` receives typed domain events; configuration rows (`notification`)
  subscribe per-`eventType` + `tags`, so users can route "release grabbed" to Discord and "indexer failed" to email. The
  event types fired today are `acquisition.release.grabbed`, `acquisition.import.completed`, `discovery.indexer.failed`
  and `acquisition.client.failed` (see `events.md`).

## 6. Security rules for integrations

- Credentials (api keys, tokens, passwords) are stored only as encrypted-at-rest values (env-driven secret key), are
  **never** returned by API responses, never logged (Rule 7). Stored settings use dedicated zod masks in debug logs.
- Outbound calls carry timeouts, retries with backoff, and per-provider rate limiting to avoid harming third-party
  services.

## 7. What is real today vs planned

**Real implementations now (M1):** `NewznabProvider` (Newznab **and** Torznab over HTTP, JSON mode, basic-auth + proxy-ready,
healthcheck via `t=caps`), `SabnzbdProvider` (addurl/queue/history/delete, merges history-completed for import),
`QbittorrentProvider` (login-cookie, torrents/add/info/delete, resolves the hash from a magnet optionally), and a
`LocalStorageProvider` (hardlink→copy import, largest-video discovery, disk free). Each is contract-tested against local mock
HTTP servers. In-memory indexer/download-client providers remain registered internally (test infrastructure only — the
`indexer_definition` seed row stays but is filtered out of `GET /indexers/definitions`, and there is no implicit
fallback to them if a real client isn't configured; nothing memory-backed is reachable from the UI). Contract-first
rule holds: core never constructs vendor-specific clients — it goes through `ProvidersService` in `apps/api`.
