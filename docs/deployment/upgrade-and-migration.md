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
set was removed — see [docs/implementation/roadmap.md](../implementation/roadmap.md)).

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
- **Scope/limits** — only SQLite upstreams today (Postgres-exports are a roadmap item); upstream DB schemas vary by
  version, so if a column is missing the importer tolerates it and reports it rather than aborting. Exotic/custom
  Indexer implementations may land with placeholder settings (baseUrl invalid) — reconfigure them in the UI.

### After importing

1. Point your media/downloads paths at the volumes (`paths.rootFolders`, `paths.downloads`).
2. Set `metadata.tmdbApiKey` (System → Settings) and run metadata refresh on series to fill seasons/episodes images.
3. Add real download clients (SABnzbd/qBittorrent) and indexers, run a health check.
4. Stop Sonarr/Radarr/Prowlarr and repoint any automation at MediaNexus `/api/v1` (or its compat surfaces:
   `/api/sonarr/v3`, `/api/radarr/v3`, `/api/prowlarr/v1`).
5. Confirm the acceptance path: a monitored series auto-grabs a missing episode and imports it into the library.

## Rollback

Keep your previous app + its data. If anything is wrong, restore the old app; MediaNexus never modifies the source DB,
so nothing is lost. Remove the MediaNexus `data/` (or restore `data.bak`) and re-import once a fix ships.
