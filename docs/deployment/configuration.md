# MediaNexus — Configuration

All configuration flows through environment variables (secrets via `_FILE` suffix for Docker secrets) and the persisted
`setting` table for runtime/admin-editable settings.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | runtime mode |
| `PORT` | `7373` | API listen port |
| `DATABASE_URL` | `file:./data/media-nexus.db` | Drizzle connection string. SQLite fully supported now; `postgres://…` detected but raises a clear error until PG driver lands (M1.1) |
| `MEDIA_NEXUS_SECRET` | *(required, generate `openssl rand -hex 32`)* | encryption key for stored credentials |
| `CORS_ORIGINS` | `` | comma-separated allowed origins |
| `JOB_CONCURRENCY` | `2` | running job workers |
| `LOG_LEVEL` | `info` | structured log level |
| `PUID` / `PGID` | `1000` | container UID/GID (docker) |
| `TZ` | `UTC` | timezone |

## Runtime settings (`setting` table, admin-editable via `PUT /api/v1/system/config`)

Namespaced keys, e.g.:

- `paths.rootFolders` — library root folders
- `paths.downloads` — downloads staging root
- `media.naming.movies` / `media.naming.episodes` — naming templates
- `media.preferredProtocol` — usenet vs torrent preference
- `system.timezone`
- `ui.theme` — dark/light

Settings are validated against a zod schema in `packages/shared/src/config.ts` before persistence.

## Secrets handling

- API keys: hashed (SHA-256) at rest; fetched by hash lookup at request time; never returned.
- Provider credentials (indexers/download clients/notifications): encrypted with `MEDIA_NEXUS_SECRET` before persistence.
- Log redaction: structured logger redacts fields matching `/key|token|pass|secret|api/` in `settings` payloads.
