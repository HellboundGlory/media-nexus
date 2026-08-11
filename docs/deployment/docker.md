# MediaNexus — Docker Deployment

## Quick start

```bash
cp .env.example .env   # adjust secrets/volumes
docker compose up -d   # builds the single `app` image (default: sqlite volume)
docker compose ps      # health check turns green (start_period)
```

| Service | Port | Notes |
|---|---|---|
| `app` | `${WEB_PORT:-8080}` → container `7373` | single container: NestJS API serves the built web UI directly (static assets + SPA fallback) and swagger at `/api/docs` |
| *(planned)* `postgres` | n/a | PostgreSQL wired when the PG driver lands (roadmap M1.1); today the default is SQLite on a volume |

This is **one container, one port** — there is no separate `web`/nginx container and no reverse proxy. The first
time you open it, you'll be walked through creating a single admin login (see [docs/security.md](../security.md)) —
no API key to copy out of logs. It's still meant for LAN/private-network use only, never exposed directly to the
public internet.

## Volumes / persistence

- `./data/db:/data/db` — SQLite database (default). All app config/settings live here (the `setting` table), not in a
  separate config directory. Postgres is not wired into compose yet (roadmap M1.1); once it lands, point
  `DATABASE_URL` at it instead of using this volume.
- `./data/media:/data/media` — media library (mount the host library here)
- `./data/downloads:/data/downloads` — downloads staging (must be same filesystem as media for hardlinks)

## Paths are set in the app, not via environment variables

Root folders and the downloads path (`paths.rootFolders`, `paths.downloads`) are **runtime settings**, configured
in the web UI (System → Settings) or via `PUT /api/v1/system/config` — see
[docs/deployment/configuration.md](configuration.md). Point them at whatever container paths your volumes are
mounted to (`/data/media`, `/data/downloads` in the example above). There is no environment variable for this —
`DATABASE_URL`, `MEDIA_NEXUS_SECRET`, `TZ` are the only deploy-time env vars that affect paths/behavior; nothing
host-specific is baked into the image.

## Health checks & graceful shutdown

- The `app` container checks `/health/live` and `/health/ready` (DB); it stops gracefully via SIGTERM (Nest app hooks
  `onModuleDestroy` to drain job workers and close connections).
- Compose `stop_grace_period` gives jobs time to settle; jobs are claim-lease based so a killed worker is recoverable on
  restart.

## Debugging: no shell in the runtime image

The runtime stage is a [distroless](https://github.com/GoogleContainerTools/distroless) image (no shell, no package
manager) to keep the published image's vulnerability surface small — `docker exec -it app sh` (or `bash`) will not
work. Use `docker logs app`, the `/health/live` and `/health/ready` endpoints, and `/metrics` (Prometheus) instead.

## Do not put this behind a public reverse proxy

MediaNexus has a single admin login, not multi-user accounts or roles (see [docs/security.md](../security.md)) — it
is designed for LAN/private-network use, not for public exposure. There is deliberately no reverse-proxy/HTTPS-termination
example in this repo; if you choose to expose it anyway (VPN endpoint, Tailscale, etc.), that is an operator decision
outside the scope of what MediaNexus documents or supports.
