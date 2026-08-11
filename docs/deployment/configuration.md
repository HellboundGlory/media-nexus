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
| `MEDIA_NEXUS_SECRET_FILE` | — | path to read `MEDIA_NEXUS_SECRET` from (Docker secrets) |
| `MEDIA_NEXUS_BOOTSTRAP_KEY` | *(generated if unset)* | pins the first-run system API key instead of generating one (e.g. for CI/tests) |
| `AUTO_MIGRATE` | `true` | run pending Drizzle migrations automatically on boot |
| `JOB_CONCURRENCY` | `2` | running job workers |
| `LOG_LEVEL` | `info` | structured log level |
| `TZ` | `UTC` | timezone |
| `WEB_PORT` | `8080` | (compose only) host port mapped to the container's port 7373 |

There is no `CORS_ORIGINS` or `TRUST_PROXY` — the API serves the web UI itself (same-origin, one process, one port), and
this app is not meant to sit behind a reverse proxy (see [docs/security.md](../security.md)).

## Runtime settings (`setting` table, admin-editable via `PUT /api/v1/system/config`)

Namespaced keys, e.g.:

- `paths.rootFolders` — library root folders. **This, not an environment variable, is how you point MediaNexus at
  your media library** — set it to wherever your media volume is mounted inside the container (System → Settings).
- `paths.downloads` — downloads staging root, same idea — set it to your downloads volume's container path. Must be
  on the same filesystem as `paths.rootFolders` for hardlink imports.
- `media.naming.movies` / `media.naming.episodes` — naming templates
- `media.preferredProtocol` — usenet vs torrent preference
- `system.timezone`
- `ui.theme` — dark/light

Settings are validated against a zod schema in `packages/shared/src/config.ts` before persistence.

## Secrets handling

- API keys: hashed (SHA-256) at rest for auth lookups, plus an AES-256-GCM copy encrypted with `MEDIA_NEXUS_SECRET`
  so the raw value can be revealed again later (System → API key) without rotating it.
- Admin password (browser login): scrypt-hashed, random salt per password. Session cookies are signed (HMAC-SHA256),
  not stored server-side — see [docs/security.md](../security.md) for the full session-auth design.
- Provider credentials (indexers/download clients/notifications): **not encrypted at rest** — stored as plain JSON in
  the `settings` column (see [docs/security.md](../security.md) hardening checklist). Redacted in native API
  *responses*, but readable directly from the database file.
- Log redaction: structured logger redacts fields matching `/key|token|pass|secret|api/` in `settings` payloads.
