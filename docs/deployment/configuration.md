# MediaNexus — Configuration

All configuration flows through environment variables (secrets via `_FILE` suffix for Docker secrets) and the persisted
`setting` table for runtime/admin-editable settings.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | runtime mode |
| `PORT` | `7373` | API listen port |
| `DATABASE_URL` | `file:./data/media-nexus.db` | Drizzle connection string. Dialect chosen by scheme: `sqlite:`/`file:`/`:memory:`/bare path → SQLite (`better-sqlite3`); `postgres://…`/`postgresql://…` → PostgreSQL (`pg`). Both dialects are fully implemented and supported. |
| `MEDIA_NEXUS_SECRET` | *(required, generate `openssl rand -hex 32`)* | encryption key for stored credentials |
| `MEDIA_NEXUS_SECRET_FILE` | — | path to read `MEDIA_NEXUS_SECRET` from (Docker secrets) |
| `MEDIA_NEXUS_BOOTSTRAP_KEY` | *(generated if unset)* | pins the first-run system API key instead of generating one (e.g. for CI/tests) |
| `AUTO_MIGRATE` | `true` | run pending Drizzle migrations automatically on boot |
| `JOB_CONCURRENCY` | `2` | running job workers |
| `LOG_LEVEL` | `info` | structured log level |
| `TZ` | `UTC` | timezone |
| `WEB_PORT` | `7373` | (compose only) host port mapped to the container's port 7373 |

There is no `CORS_ORIGINS` or `TRUST_PROXY` — the API serves the web UI itself (same-origin, one process, one port), and
this app is not meant to sit behind a reverse proxy (see [docs/security.md](../security.md)).

## Runtime settings (`setting` table, admin-editable via `PUT /api/v1/system/config`)

Namespaced keys, e.g.:

- `paths.downloads` — downloads staging root. **This, not an environment variable, is how you point MediaNexus at
  your downloads volume** — set it to wherever your downloads volume is mounted inside the container (System →
  Settings). Must be on the same filesystem as your root folders (below) for hardlink imports.
- `media.naming.movies` / `media.naming.episodes` — naming templates
- `media.preferredProtocol` — usenet vs torrent preference
- `ui.theme` — dark/light

Root folders (where your media library lives) are **not** a `setting` key — they're a real table with their own
CRUD endpoints: `GET/POST /api/v1/root-folders`, `GET/PUT/DELETE /api/v1/root-folders/:id`. Add one from the web UI
(System → Settings, or wherever a root-folder picker appears) pointing at wherever your media volume is mounted
inside the container, on the same filesystem as `paths.downloads`.

Settings are validated against a zod schema in `packages/shared/src/config.ts` before persistence.

## Secrets handling

Full detail (API keys, admin password, session auth, and provider/indexer/download-client credential encryption)
lives in [docs/security.md](../security.md) — not duplicated here to avoid the two drifting apart. Short version:
`MEDIA_NEXUS_SECRET` is the encryption key behind all of it, so treat it as the one secret that matters most to
protect.
