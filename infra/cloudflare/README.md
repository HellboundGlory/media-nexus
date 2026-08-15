# MediaNexus metadata proxy (Cloudflare Worker)

A single Cloudflare Worker (`medianexus-proxy`) that proxies BOTH metadata backends used by
MediaNexus, so the real API keys never ship to a client or appear in the MediaNexus repo/image.
This is the same pattern Sonarr uses with its hosted proxy (`skyhook.sonarr.tv`).

The worker holds both keys as encrypted Cloudflare **secrets** and injects them on your behalf:

| Route | Backend | Auth handling |
|-------|---------|---------------|
| `/tvdb/*` | `https://api4.thetvdb.com/v4/*` | Worker logs in with `TVDB_API_KEY`, caches a bearer token, injects it |
| `/tmdb/*` | `https://api.themoviedb.org/3/*` | Worker injects `?api_key=TMDB_API_KEY` |

A bare GET to `/` returns a plain `MediaNexus proxy is up. Routes: /tvdb/*, /tmdb/*` line.

## Live URLs (placeholders — confirm the real subdomain after the rename)

- `https://medianexus-proxy.hellboundg-e09.workers.dev/tvdb` — MediaNexus's default
  `metadata.tvdbBaseUrl`
- `https://medianexus-proxy.hellboundg-e09.workers.dev/tmdb` — MediaNexus's default
  `metadata.tmdbBaseUrl` (used automatically when no `metadata.tmdbApiKey` is set)

These URLs are MediaNexus's defaults (not secrets — they are public by design). MediaNexus's TVDB
and TMDB clients treat the Worker as if they were the upstream API directly; no client-side login
or key is needed in shared-proxy mode.

## Deploy / update the script (operator action)

**Create (first time):**
1. dash.cloudflare.com → Workers & Pages → Create → Workers → Create Worker.
   Name it `medianexus-proxy`.
2. Settings → Variables and Secrets → Add, toggled **Encrypted secret**, for **both**:
   - `TVDB_API_KEY` = your TheTVDB v4 API key
   - `TMDB_API_KEY` = your TheMovieDB v3 API key
   Save & deploy.

**Paste this repository's worker code:**
1. Open the Worker → **Edit code**.
2. Replace the placeholder template entirely with the contents of `proxy.js` (in this directory)
   — or connect the Git integration below.
3. **Save and Deploy** (button bottom-right).

The Worker reads the keys from the Cloudflare secrets at runtime, not from source or logs, so
pasting the script is safe.

**Whenever the script in this repo changes**, redeploy. Run
`curl https://medianexus-proxy.hellboundg-e09.workers.dev/` afterwards — a bare GET returns the
"proxy is up" line to confirm the deploy.

## Git integration (optional, auto-deploy)

1. Dashboard → the `medianexus-proxy` Worker → **Settings** → **Variables and Secrets** (set
   `TVDB_API_KEY` + `TMDB_API_KEY` as encrypted secrets).
2. **Workers → (this Worker) → Settings → Builds & Deployments → Git integration → Connect**,
   select the MediaNexus repo, branch `main`, and the following root directory + build setup:
   - Root directory: `infra/cloudflare`
   - Main module / build main: `proxy.js`
   - Build command: none required (plain JS worker)
   - Production branch: `main`
3. Cloudflare will auto-deploy `infra/cloudflare/proxy.js` on every push to `main`.
   Note: `wrangler.toml` in the worker root keeps the name/main/compatibility pinned; if the
   Git-integration UI asks for a wrangler file, point it at `wrangler.toml` here.

## Test after deploy

- `GET /`                  → `MediaNexus proxy is up. ...`
- `GET /tvdb/series/{id}`  → TVDB JSON (502 `proxy error` if `TVDB_API_KEY` isn't set)
- `GET /tmdb/movie/{id}`   → TMDB JSON (502 `TMDB_API_KEY secret is not set` if the secret is missing)

## Optional hardening (not required)

- **Rate limiting:** the Worker currently does none. To add cheap IP rate limiting, track
  `request.headers.get("cf-connecting-ip")` in a `caches.default`/Cache API or Durable Object
  bucket and return 429 past a threshold. Basic friction only, not auth.
- **Origin restriction:** optionally reject requests whose `Origin`/`Sec-Fetch-Site` don't look
  like a MediaNexus install. This is cosmetic — anyone can curl the URL regardless, exactly like
  Sonarr's public proxy.

## Attribution

MediaNexus displays "Data provided by TheTVDB" and "This product uses the TMDB API but is not
endorsed or certified by TMDB" lines in the Settings/System UI, as their free-tier API terms
require.
