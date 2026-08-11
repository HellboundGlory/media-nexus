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

This is **one container, one port** — there is no separate `web`/nginx container and no reverse proxy. See
[docs/security.md](../security.md): the app has no login beyond a single system API key, so it is meant for
LAN/private-network use only, never exposed directly to the public internet.

## Volumes / persistence

- `./data/db:/data/db` — SQLite database + uploads (default). Postgres is not wired into compose yet (roadmap M1.1); once
  it lands, point `DATABASE_URL` at it instead of using this volume.
- `./data/media:/data/media` — media library (mount the host library here)
- `./data/downloads:/data/downloads` — downloads staging (must be same filesystem for hardlinks)
- `./data/config:/data/config` — application config/settings persistence

## Images are configurable, not hard-coded

Paths in the deploy are **environment-driven**: `DATABASE_URL`, `MEDIA_NEXUS_DATA_DIR`, `MEDIA_NEXUS_MEDIA_DIR`,
`MEDIA_NEXUS_DOWNLOADS_DIR`, `TZ`, `PUID`/`PGID`. Nothing host-specific is baked into the image.

## Health checks & graceful shutdown

- The `app` container checks `/health/live` and `/health/ready` (DB); it stops gracefully via SIGTERM (Nest app hooks
  `onModuleDestroy` to drain job workers and close connections).
- Compose `stop_grace_period` gives jobs time to settle; jobs are claim-lease based so a killed worker is recoverable on
  restart.

## Do not put this behind a public reverse proxy

MediaNexus has no login beyond a single system API key (see [docs/security.md](../security.md)) — it is designed for
LAN/private-network use, not for public exposure. There is deliberately no reverse-proxy/HTTPS-termination example in
this repo; if you choose to expose it anyway (VPN endpoint, Tailscale, etc.), that is an operator decision outside the
scope of what MediaNexus documents or supports.

> Note: the current dev environment has no Docker daemon; the Dockerfile/compose are authored and `docker compose
> config`-validation-compatible, and exercised by the CI container build before we claim them verified end-to-end.
