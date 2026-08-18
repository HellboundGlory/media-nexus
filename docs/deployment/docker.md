# MediaNexus — Docker Deployment

Two compose files, two different jobs:

- **Root `docker-compose.yml`** (this section) — the fastest path to trying the app: builds the image from local
  source, SQLite on a volume, no VPN. This is what the README's Quick Start uses.
- **`docker/docker-compose.example.yml`** (see below) — the recommended setup for a real deployment: pulls the
  published image, Postgres instead of SQLite, and all outbound traffic routed through a VPN via Gluetun.

## Quick start

```bash
cp .env.example .env   # adjust secrets/volumes
docker compose up -d   # builds the single `app` image (default: sqlite volume)
docker compose ps      # health check turns green (start_period)
```

| Service | Port | Notes |
|---|---|---|
| `app` | `${WEB_PORT:-7373}` → container `7373` | single container: NestJS API serves the built web UI directly (static assets + SPA fallback) and swagger at `/api/docs` |

This is **one container, one port** — there is no separate `web`/nginx container and no reverse proxy. The first
time you open it, you'll be walked through creating a single admin login (see [docs/security.md](../security.md)) —
no API key to copy out of logs. It's still meant for LAN/private-network use only, never exposed directly to the
public internet.

## Recommended: Postgres + Gluetun VPN

`docker/docker-compose.example.yml` is the recommended production shape — four services (`media-nexus`, `postgres`,
`nzbget`, `gluetun`) instead of one:

```bash
cp docker/.env.example docker/.env   # NOT the repo root .env — this file lives next to the compose file
# fill in MEDIA_NEXUS_SECRET, POSTGRES_PASSWORD, NZBGET_USER/PASS, and your VPN provider's credentials
docker compose -f docker/docker-compose.example.yml up -d
docker compose -f docker/docker-compose.example.yml logs media-nexus | grep "API key"
```

| Service | Port | Notes |
|---|---|---|
| `gluetun` | `${WEB_PORT:-7373}`, `${NZBGET_PORT:-6789}` → containers `7373`, `6789` | owns the network; publishes both UIs since `media-nexus` and `nzbget` have no ports of their own |
| `media-nexus` | *(shares gluetun's network — no port of its own)* | `network_mode: "service:gluetun"`, so every outbound request (indexers, download clients, TMDB) goes through the VPN tunnel |
| `nzbget` | *(shares gluetun's network — no port of its own)* | usenet download client, same `network_mode: "service:gluetun"` — its downloads go through the tunnel too; `media-nexus` reaches it at `http://127.0.0.1:6789` since they share a network namespace |
| `postgres` | n/a, internal only | real Postgres instead of the SQLite default; `DATABASE_URL` is assembled from `POSTGRES_USER`/`PASSWORD`/`DB` |

After it's up, add it in-app as a download client (System → Settings → Download Clients → NZBGet), host
`http://127.0.0.1:6789`, using the `NZBGET_USER`/`NZBGET_PASS` you set in `.env`.

Two things worth knowing about this setup: gluetun's DNS-over-TLS (encrypts every DNS lookup, on by default) has no
way to resolve a Docker-internal name like `postgres` — rather than turning it off, `postgres` gets a static IP on
the `media-nexus` network and `DATABASE_URL` connects to that IP directly, so the connection never needs DNS at all
and DoT stays fully on for everything else. (Docker also flatly rejects combining `extra_hosts` with
`network_mode: "service:X"` — "conflicting options" — so a static IP is the only way to do this, not just the
tidier one.) `media-nexus` ↔ `nzbget` needs no such workaround since sharing gluetun's network namespace means they
talk over `127.0.0.1`, which never needs DNS in the first place. And `FIREWALL_OUTBOUND_SUBNETS` allow-lists your
LAN (so the published UIs stay reachable) and the compose file's own docker network (so `media-nexus` can still
reach `postgres` over it) without forcing either through the VPN tunnel.

## Volumes / persistence

- `./data/db:/data/db` — SQLite database (root compose's default). All app config/settings live here (the `setting`
  table), not in a separate config directory.
- **Using Postgres instead** (either the `docker/` example above, or your own instance): point `DATABASE_URL` at it
  (e.g. `postgres://user:password@host:5432/medianexus`) — the app connects, self-migrates, seeds, and runs its
  startup backfills against Postgres on boot exactly as it does for SQLite, and `./data/db` goes unused. The online
  backup feature (System → Backup) is SQLite-only — on Postgres it degrades to `{skipped}`; use `pg_dump` instead
  (see [upgrade-and-migration.md](upgrade-and-migration.md)).
- `./data/media:/data/media` — media library (mount the host library here)
- `./data/downloads:/data/downloads` — downloads staging (must be same filesystem as media for hardlinks)
- `./data/nzbget:/config` — NZBGet's own settings/queue state (Postgres+Gluetun example only); it shares the same
  `./data/downloads` host path as `media-nexus` so completed downloads can be hardlinked into the library

## Paths are set in the app, not via environment variables

Root folders and the downloads path (`paths.rootFolders`, `paths.downloads`) are **runtime settings**, configured
in the web UI (System → Settings) or via `PUT /api/v1/system/config` — see
[docs/deployment/configuration.md](configuration.md). Point them at whatever container paths your volumes are
mounted to (`/data/media`, `/data/downloads` in the example above). There is no environment variable for this —
`DATABASE_URL`, `MEDIA_NEXUS_SECRET`, `TZ` are the only deploy-time env vars that affect paths/behavior; nothing
host-specific is baked into the image.

## Health checks & graceful shutdown

- The app container (`app` in the root compose, `media-nexus` in the Postgres+Gluetun example) checks `/health/live`
  and `/health/ready` (DB); it stops gracefully via SIGTERM (Nest app hooks `onModuleDestroy` to drain job workers
  and close connections).
- Compose `stop_grace_period` gives jobs time to settle; jobs are claim-lease based so a killed worker is recoverable on
  restart.

## Debugging: no shell in the runtime image

The runtime stage is a [distroless](https://github.com/GoogleContainerTools/distroless) image (no shell, no package
manager) to keep the published image's vulnerability surface small — `docker exec -it <service> sh` (or `bash`) will
not work. Use `docker logs <service>` (`app`, or `media-nexus` for the Postgres+Gluetun example), the `/health/live`
and `/health/ready` endpoints, and `/metrics` (Prometheus) instead.

## Do not put this behind a public reverse proxy

MediaNexus has a single admin login, not multi-user accounts or roles (see [docs/security.md](../security.md)) — it
is designed for LAN/private-network use, not for public exposure. There is deliberately no reverse-proxy/HTTPS-termination
example in this repo; if you choose to expose it anyway (VPN endpoint, Tailscale, etc.), that is an operator decision
outside the scope of what MediaNexus documents or supports.
