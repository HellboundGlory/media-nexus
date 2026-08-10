# MediaNexus — Docker Deployment

## Quick start

```bash
cp .env.example .env   # adjust secrets/volumes
docker compose up -d   # builds api + web, optional postgres (default off → sqlite volume)
docker compose ps      # health checks turn green (start_period for api)
```

| Service | Port | Notes |
|---|---|---|
| `web` | 8080 | nginx serves SPA + reverse-proxies `/api` → api:7373, `/health` → api |
| `api` | 7373 (internal) | NestJS API, swagger at `/api/docs` |
| *(planned)* `postgres` | n/a | PostgreSQL service wired when the PG driver lands (roadmap M1.1); today the default is SQLite on a volume |

## Volumes / persistence

- `./data/db:/data/db` — SQLite database + uploads (default). For Postgres use a named volume or bind mount; the DB is
  managed by the `postgres` service.
- `./data/media:/data/media` — media library (mount the host library here)
- `./data/downloads:/data/downloads` — downloads staging (must be same filesystem for hardlinks)
- `./data/config:/data/config` — application config/settings persistence

## Images are configurable, not hard-coded

Paths in the deploy are **environment-driven**: `MEDIA_NEXUS_DB_PATH`, `MEDIA_NEXUS_DATA_DIR`, `MEDIA_NEXUS_MEDIA_DIR`,
`MEDIA_NEXUS_DOWNLOADS_DIR`, `TZ`, `PUID`/`PGID` (non-root runtime). Nothing host-specific is baked into the images.

## Health checks & graceful shutdown

- `web`: checks HTTP 200 on `/health/live` (through nginx → api).
- `api`: checks `/health/live` and `/health/ready` (DB); container stops gracefully via SIGTERM (Nest app hooks
  `onModuleDestroy` to drain job workers and close connections).
- Compose `stop_grace_period` gives jobs time to settle; jobs are claim-lease based so a killed worker is recoverable on
  restart.

## Reverse proxies & HTTPS

Terminate TLS externally (Caddy/Traefik/nginx proxy) and forward to `:8080`. Set `CORS_ORIGINS` and `TRUST_PROXY=1` (for
correct client IPs/secure cookies) when behind a proxy. Optional `Dockerfile` distroless-style slim runtime for `api`.

> Note: the current dev environment has no Docker daemon; these files are authored and `docker compose config`
> validation-compatible, and exercised by the CI container build before we claim them verified end-to-end.
