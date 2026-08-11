# MediaNexus — Development Setup

## Prerequisites

- Node.js **>= 20** (scaffold authored/tested on Node 22) and npm **>= 10**.
- SQLite is built-in for local dev (`better-sqlite3`). PostgreSQL only needed for prod-style testing.

## Install & first run

```bash
git clone <repo-url> media-nexus && cd media-nexus
npm install              # installs all workspaces
npm run db:migrate       # create/upgrade local dev DB (sqlite at ./data/media-nexus.db)
npm run db:seed          # seed: bootstrap system api key, quality profiles, indexer definitions
npm run dev:api          # NestJS API on :7373 with watch+swagger at /api/docs
npm run dev:web          # Vite web on :5173 (proxies /api to :7373)
```

First-run bootstrap mints one system API key and prints it once to the API logs — there is no user account, login or
password. The key is stored hashed in the DB and is the value for the `X-Api-Key` header in every API request (and for
`VITE_MEDIA_NEXUS_API_KEY` so the web app can talk to the API in dev). Set `MEDIA_NEXUS_BOOTSTRAP_KEY` to pin it instead
of generating a random one.

## Workspace layout & key scripts (root)

| script | effect |
|---|---|
| `npm run build` | typecheck+build all workspaces |
| `npm test` | unit tests (packages) + API e2e tests |
| `npm run lint` | eslint across repo |
| `npm run typecheck` | tsc --noEmit across repo |
| `npm run db:migrate` / `db:seed` | Drizzle migrate / seed |
| `npm run dev` | concurrently run api+web |

## Config via environment

See `.env.example`. Key variables: `NODE_ENV`, `PORT` (default 7373), `DATABASE_URL` (sqlite path or postgres://…),
`MEDIA_NEXUS_SECRET` (encryption/secret key — generate via `openssl rand -hex 32`), `MEDIA_NEXUS_BOOTSTRAP_KEY`,
`JOB_CONCURRENCY`. Secrets may be supplied via `_FILE` env suffix (e.g. `MEDIA_NEXUS_SECRET_FILE`) for Docker secrets.
There is no `CORS_ORIGINS` — the web UI is same-origin with the API.

## Branching / contribution

See `docs/development/contributing.md`.
