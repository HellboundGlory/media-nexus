# MediaNexus TheTVDB v4 proxy (Cloudflare Worker)

A generic authenticated passthrough to TheTVDB's v4 API (`https://api4.thetvdb.com/v4`). It
holds the MediaNexus TheTVDB API key as an encrypted Cloudflare **secret** and injects a valid
Bearer token on every request, so the key never ships to a client or appears in the MediaNexus
repo/image. This is the same pattern Sonarr uses (`skyhook.sonarr.tv`).

## Live URL

`https://medianexus-tvdb-proxy.hellboundg-e09.workers.dev/`

This URL is MediaNexus's default `metadata.tvdbBaseUrl` (not a secret — it is public by design,
same as Sonarr's). MediaNexus's TVDB client treats the Worker as if it were TheTVDB directly;
no client-side login is needed in this shared-proxy mode.

## Deploy / update the script (operator action)

**Create (first time):**
1. dash.cloudflare.com → Workers & Pages → Create → Workers → Create Worker.
   Name it `medianexus-tvdb-proxy` (already done — the URL above is live).
2. Settings → Variables and Secrets → Add. Name `TVDB_API_KEY`, value = your key,
   toggled **Encrypted secret** (not a plain variable). Save & deploy.

**Paste this repository's worker code:**
1. Open the Worker → **Edit code**.
2. Replace the placeholder template entirely with the contents of `tvdb-proxy.js` (in this
   directory).
3. **Save and Deploy** (button bottom-right).

The Worker does not read the key from source or logs — it reads it from the Cloudflare secret
at runtime, so pasting the script is safe.

**Whenever the script in this repo changes**, repeat steps 1–3 (replace code, Save and Deploy).
Run `curl https://medianexus-tvdb-proxy.hellboundg-e09.workers.dev/` afterwards — a bare GET to
the root returns a plain "proxy is up." line to confirm the deploy.

## Test after deploy

A bare GET to the root returns `MediaNexus TheTVDB proxy is up.` (200). An authenticated API
path (e.g. `GET /series/{id}/episodes/official?page=0`) should return TVDB's normal JSON — if
`TVDB_API_KEY` isn't set, the Worker returns a 502 `proxy error`.

## Optional hardening (not required)

- **Rate limiting:** the Worker currently does none. To add cheap IP rate limiting, track
  `request.headers.get("cf-connecting-ip")` in a `caches.default`/Cache API or Durable Object
  bucket and return 429 past a threshold. Basic friction only, not auth.
- **Origin restriction:** optionally reject requests whose `Origin`/`Sec-Fetch-Site` don't look
  like a MediaNexus install. This is cosmetic — anyone can curl the URL regardless, exactly like
  Sonarr's public proxy.

## Attribution (TheTVDB terms)

MediaNexus displays a "Data provided by TheTVDB" line linking to https://www.thetvdb.com in the
Settings/System UI, as their free-tier API terms require.
