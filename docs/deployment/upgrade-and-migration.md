# MediaNexus — Upgrade & Migration Runbook

## Upgrading MediaNexus

1. `git pull` (or pull a new image tag).
2. `docker compose pull` / `docker compose build` for images.
3. Back up your data volume(s):
   ```bash
   # SQLite default:
   cp -a ./data ./data.bak.$(date +%F)
   ```
4. `docker compose up -d` — on boot the API runs pending Drizzle migrations automatically
   (`AUTO_MIGRATE=true`, which is the default) and static seeds are idempotent.
5. Verify: `curl http://localhost:8080/health/ready` -> `{"status":"ok","db":"up"}`; open the web UI.

> Migrations run automatically on start. To run them manually (e.g. before a blue-green cutover):
> `npm run db:migrate`.

**Upgrading from before browser login existed?** The next time you open the web UI, you'll land on a one-time
"create your admin account" screen instead of the dashboard — this is expected (no admin credential exists yet in
your database). Nothing else about your data changes; the existing API key mechanism for external/compat clients is
untouched. See [docs/security.md](../security.md).

## Migrating data from an existing *arr setup

Use the built-in importer to bring a **live SQLite database** from Sonarr, Radarr or Prowlarr into MediaNexus:

```bash
npm install
npm run build:backend

# kind is auto-detected when omitted; --target defaults to DATABASE_URL / ./data/media-nexus.db
npm run import:upstream -- --kind sonarr   --db /path/to/sonarr.db
npm run import:upstream -- --kind radarr   --db /path/to/radarr.db
npm run import:upstream -- --kind prowlarr --db /path/to/prowlarr.db
```

There is no `--kind seerr`: MediaNexus has no user accounts, requests or watchlists to import data into (that feature
set was removed).

### What gets imported (per upstream)

| Upstream | Imported |
|---|---|
| Sonarr | series, seasons, episodes (+monitoring/air dates), quality profiles, history, indexers |
| Radarr | movies, quality profiles, history, indexers |
| Prowlarr | indexers (settings passthrough) |

### Properties & behavior

- **Idempotent** — derived ids mean re-running the importer skips already-imported items. Safe to run repeatedly.
- **Report** — the CLI prints per-entity counts, `skipped`, `unknown` and any `errors` (exit code 2 on errors).
- **Not a destructive migration** — the source DB is opened read-only; MediaNexus data is never deleted.
- **Scope/limits** — only SQLite upstreams today (a Postgres-exports source isn't supported yet); upstream DB schemas vary by
  version, so if a column is missing the importer tolerates it and reports it rather than aborting. Exotic/custom
  Indexer implementations may land with placeholder settings (baseUrl invalid) — reconfigure them in the UI.

### After importing

1. Point your media/downloads paths at the volumes: add root folder(s) (`POST /api/v1/root-folders`, or the web UI)
   and set `paths.downloads` (System → Settings).
2. Set `metadata.tmdbApiKey` (System → Settings) and run metadata refresh on series to fill seasons/episodes images.
3. Add real download clients (SABnzbd/qBittorrent) and indexers, run a health check.
4. Stop Sonarr/Radarr/Prowlarr and repoint any automation at MediaNexus `/api/v1` (or its compat surfaces:
   `/api/sonarr/v3`, `/api/radarr/v3`, `/api/prowlarr/v1`).
5. Confirm the acceptance path: a monitored series auto-grabs a missing episode and imports it into the library.

## Backup & restore

Beyond the manual `data.bak` copy above (for upgrades), MediaNexus can back itself up on a schedule:

- Set `system.backupPath` (System → Settings, or `PUT /api/v1/system/config`) to a directory the app can write to —
  it's empty by default, which leaves the `system.backup` job disabled (it no-ops cleanly rather than guessing a
  location). `system.backupRetentionCount` (default 7) bounds how many backups are kept; older ones are deleted
  automatically as new ones land.
- The job runs weekly (`0 3 * * 0`) and can also be triggered on demand: `POST /api/v1/system/commands/system.backup`.
- Each run produces one timestamped file, `medianexus-backup-<ISO timestamp>.sqlite3`, via SQLite's own online-backup
  API — safe to run against the live, in-use database (no need to stop the app first). List existing backups with
  `GET /api/v1/system/backups`.
- **No separate config export.** The backup file already contains the full `setting`/`indexer`/`download_client`
  tables (credentials included — encrypted at rest, see [docs/security.md](../security.md)), so it's a complete,
  restorable snapshot on its own.
- **Postgres:** this whole online-backup flow is SQLite-only — on a Postgres-backed instance `system.backup`
  degrades to `{skipped}` rather than failing. Use `pg_dump`/`pg_restore` against the `postgres` volume/service
  instead (see [docker.md](docker.md)).

**To restore a backup** — the in-app flow (System → Backup) is now the normal path:

- **Restore** a listed backup: the per-row restore icon opens a confirm dialog. It replaces the
  *entire* live database with the selected backup (a trim-exempt **safety copy of the current
  database is written automatically first** into the same backup folder), then the app restarts
  itself and the UI reloads when it returns.
- **Download** any listed backup (`GET /api/v1/system/backups/:name/download`) to move it off
  the host, and **Upload** a backup (`POST /api/v1/system/backups/upload`, multipart field
  `file`) to add one from another host. Uploaded backups are validated (read-only open + a
  `setting`-table marker + `integrity_check`) *before* being accepted, and are deliberately
  left out of the retention trim so an off-box safety net is never silently deleted.
- Restoring restarts the process via the container's `restart: unless-stopped`, matching
  Radarr's own "Restore / Restart / Reload" behavior.

The manual file-swap procedure below is still valid (e.g. restoring a backup that was never
run through the app) and doubles as the fallback for a host that won't come back:

1. Stop the app (`docker compose down`, or stop the process).
2. Replace the live database file (`DATABASE_URL`'s path, `./data/media-nexus.db` by default) with the backup file
   you want to restore, keeping the original filename the app expects.
3. Start the app back up (`docker compose up -d`). Pending migrations (if the backup predates the version you're
   restoring into) run automatically on boot, same as any other startup.
4. Verify: `curl http://localhost:8080/health/ready` -> `{"status":"ok","db":"up"}`; open the web UI and confirm
   your library/settings look like the point in time the backup was taken.

## Rollback

Keep your previous app + its data. If anything is wrong, restore the old app; MediaNexus never modifies the source DB,
so nothing is lost. Remove the MediaNexus `data/` (or restore `data.bak`) and re-import once a fix ships.
