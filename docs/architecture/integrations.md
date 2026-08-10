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

Implemented as interfaces + zod config schemas in the scaffold (interfaces are real and unit-tested; concrete vendor
drivers are roadmap items):

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
- **Cardigann** (Prowlarr): YAML templates for tracker sites with no standard API. The **format/behavior is reimplemented**
  for compatibility; note in `legal/upstream-licenses.md` that we reimplement the *format*, not Prowlarr's parser code.
- **Proxy support** (planned): HTTP/SOCKS5 per-indexer proxy, plus FlareSolverr interop for Cloudflare-walled trackers
  (matching Prowlarr's documented capability set).
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
- **Media servers:** Plex/Jellyfin/Emby for library scan, user list import (requesters), availability reporting. The
  `media_availability` table (see domain model) is the seam: availability syncs from media servers, requests read it.
- **Notifications:** a `NotificationProvider` receives typed domain events; configuration rows (`notification_provider`)
  subscribe per-`eventType` + `tags`, so users can route "grab" to Discord and "request approved" to email. Concrete sinks
  are roadmap items.

## 6. Security rules for integrations

- Credentials (api keys, tokens, passwords) are stored only as encrypted-at-rest values (env-driven secret key), are
  **never** returned by API responses, never logged (Rule 7). Stored settings use dedicated zod masks in debug logs.
- Outbound calls carry timeouts, retries with backoff, and per-provider rate limiting to avoid harming third-party
  services.

## 7. What is real today vs planned

In the scaffold, the contracts, registries, zod config schemas, and a **`MemoryIndexerProvider`** / **`MemoryDownloadClientProvider`**
test-double pair are implemented and unit-tested; the first real provider (Newznab over HTTP) is milestone M1 in the
roadmap. Nothing in this document claims a live vendor integration exists yet.
