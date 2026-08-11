# MediaNexus — Security

This is the security guide + hardening baseline. **This is an engineering document, not a legal or security audit.**

## Trust model

- A self-hosted app owned by the operator. The threat model is: unauthenticated network access, API-key leakage,
  secrets in logs/responses, abuse of write endpoints, and credentials on the wire.
- **Single credential style:** API keys only (`X-Api-Key` header, hashed at rest). There are no user accounts, no login,
  no roles/permission tiers — any valid key is a full-access system key, `_arr`-style (same trust model as
  Sonarr/Radarr/Prowlarr's own API-key auth; see `architecture/technology-decisions.md` ADR-010). This is deliberate,
  not a placeholder for a future login: MediaNexus is meant to run on a trusted LAN/private network, not to be exposed
  to the public internet or shared with untrusted users.

## Authz matrix

| Resource | Reads | Writes | Notes |
|---|---|---|---|
| `/api/v1/movies`, `/series`, `/episode`, `/wanted`, `/calendar`, `/history`, `/queue` | any API key | any API key | UI + automation |
| `/api/v1/movies|series/:id/metadata`, `/indexers` (create/delete), `/download-clients`, `/system/config`, `/notifications`, `/media-servers` | any API key | any API key | Guarded by `AdminGuard`, which requires `principal.isAdmin` — always `true` for a valid key, so this is a routing convention (write paths are grouped behind the guard) rather than a real permission tier |
| Cross-domain `/api/sonarr|radarr|prowlarr/v1/*` | API key | API key | Compatibility surfaces; Prowlarr indexer list intentionally exposes logged-in config (that's the interop contract) — keep native lists redacted (below) |
| `/health/*`, `/metrics` | public | — | liveness/readiness/scrape |

## Secrets handling (implemented)

- API keys stored **hashed (SHA-256)** for auth lookups, plus an **AES-256-GCM encrypted copy** (keyed from
  `MEDIA_NEXUS_SECRET`) so the raw value can be revealed again later from System → API key without rotating it
  (`GET /api/v1/auth/key`, returns the calling key's own value only). There are no passwords to hash — no user
  accounts exist. Keys minted before this existed have no encrypted copy and must be regenerated once to enable reveal.
- `MEDIA_NEXUS_SECRET` (encryption key) from env or `MEDIA_NEXUS_SECRET_FILE` (Docker secrets). Currently only the API
  key uses it for at-rest encryption; indexer/download-client/notification credentials are **not yet encrypted at
  rest** (stored as plain JSON in `settings`) — see the hardening checklist below.
- **Native API responses redact credentials**: `redactDeep()`/`redactSettings()` mask field names matching
  `api.?key | apikey | token | secret | password | pass | credential | user | username | chatid` in
  `/indexers`, `/download-clients`, `/system/config` and `/media-servers` responses (compat surfaces that need the
  settings for interop are intentionally separate).
- Structured logger redacts secret-ish fields (`Logger` in `packages/shared`).

## Transport & headers

- MediaNexus does not terminate or expect TLS itself, and there is no `TRUST_PROXY` setting — this app is not meant to
  sit behind a reverse proxy or be exposed to the public internet (see `deployment/docker.md`). If you need TLS for
  LAN/private-network access, use a VPN/overlay network (e.g. Tailscale) rather than a public-facing proxy.
- API sets: `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer`,
  `X-XSS-Protection: 0`, `Cross-Origin-Opener-Policy: same-origin` (`SecurityHeadersMiddleware`).

## Abuse & protection

- Rate limiting (`RateLimitGuard`, windowed per-IP bucket) on `POST /api/v1/grabs` (single-instance; a Redis-backed
  limiter is the documented scale-out).
- No CORS handling — the web UI is served same-origin by the same process as the API.
- Audit log records admin/security-relevant actions (`/api/v1/system/audit`).

## Hardening checklist (ongoing)

- [x] Hash API keys
- [x] Redact credentials in native API responses
- [x] Admin-gate config/metadata/notifications writes
- [x] Security response headers
- [x] Rate limit sensitive writes
- [x] Correlation IDs + audit log
- [x] Rotatable API keys (`POST /api/v1/auth/regenerate-key`)
- [x] Revealable API key without rotation (`GET /api/v1/auth/key`, AES-256-GCM at rest)
- [ ] Scope enforcement beyond `*` (all keys remain full-access system keys)
- [ ] Encrypt indexer/download-client/notification credentials at rest (currently plain JSON in `settings`)
- [ ] Secrets manager integration (e.g., Vault) for `MEDIA_NEXUS_SECRET`
- [ ] Third-party dependency auditing (`npm audit` / Dependabot) as part of CI

> Login sessions (JWT/Plex/Jellyfin) are explicitly **not** planned — auth is deliberately single-tier API-key (see
> `architecture/technology-decisions.md` ADR-010). If that ever changes, CSRF/cookie-session hardening would need
> revisiting at that time.

> Flag (not legal): the compatibility layer reproduces public API wire shapes; it does not imply endorsement of Sonarr/
> Radarr/Prowlarr trademarks (see docs/legal/upstream-licenses.md).
