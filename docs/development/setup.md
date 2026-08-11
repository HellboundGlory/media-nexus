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

Open `http://localhost:5173` — first run walks you through creating a single admin account (username/password), same
as production; Vite's dev proxy (`/api` → `:7373`) keeps the session cookie same-origin so it works identically to the
built single-container image. Separately, first-run bootstrap also mints one system API key and prints it once to the
API logs — that one's for the `X-Api-Key` header (external/compat clients, scripts), not the browser. Set
`MEDIA_NEXUS_BOOTSTRAP_KEY` to pin it instead of generating a random one (e.g. for CI/tests).

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
