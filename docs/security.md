# MediaNexus — Security

This is the security guide + hardening baseline. **This is an engineering document, not a legal or security audit.**

## Trust model

- A self-hosted app owned by the operator. The threat model is: unauthenticated network access, API-key leakage,
  secrets in logs/responses, abuse of write endpoints, and credentials on the wire.
- Two credential styles: **API keys** (machine/automation, `X-Api-Key` header, hashed at rest) and **user accounts**
  (password-hashed users; Seerr-compatible local login mints an API-key token). A future JWT/Plex login session adds
  cookie sessions.

## Authz matrix

| Resource | Reads | Writes | Notes |
|---|---|---|---|
| `/api/v1/movies`, `/series`, `/episode`, `/wanted`, `/calendar`, `/history`, `/queue` | any API key | — (list/get) | UI + automation read |
| `/api/v1/movies|series/:id/metadata`, `/indexers` (create/delete), `/download-clients`, `/system/config`, `/users`, `/notifications`, `/media-servers` | requires `isAdmin` | requires `isAdmin` | Admin-guard (`AdminGuard`) + API-key |
| `/api/v1/requests` | non-admin sees only own | non-admin create only; approve/decline admin/moderator | `policy.ts` |
| Cross-domain `/api/sonarr|radarr|prowlarr|seerr/v1/*` | API key | API key | Compatibility surfaces; Prowlarr indexer list intentionally exposes logged-in config (that's the interop contract) — keep native lists redacted (below) |
| `/health/*`, `/metrics` | public | — | liveness/readiness/scrape |

## Secrets handling (implemented)

- API keys stored **hashed (SHA-256)**; raw key shown once at creation.
- Passwords hashed with **bcrypt** (`AuthService`).
- `MEDIA_NEXUS_SECRET` (encryption key) from env or `MEDIA_NEXUS_SECRET_FILE` (Docker secrets).
- **Native API responses redact credentials**: `redactDeep()`/`redactSettings()` mask field names matching
  `api.?key | apikey | token | secret | password | pass | credential | user | username | chatid` in
  `/indexers`, `/download-clients`, `/system/config` and `/media-servers` responses (compat surfaces that need the
  settings for interop are intentionally separate).
- Structured logger redacts secret-ish fields (`Logger` in `packages/shared`).

## Transport & headers

- TLS terminates at the reverse proxy; **set `TRUST_PROXY=1`** behind a proxy so `X-Forwarded-For`/secure cookies work.
- API sets: `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer`,
  `X-XSS-Protection: 0`, `Cross-Origin-Opener-Policy: same-origin` (`SecurityHeadersMiddleware`). nginx adds the same.

## Abuse & protection

- Rate limiting (`RateLimitGuard`, windowed per-IP bucket) on `POST /api/v1/requests` and `POST /api/v1/grabs`
  (single-instance; a Redis-backed limiter is the documented scale-out).
- CORS only when `CORS_ORIGINS` is set (default same-origin).
- Audit log records admin/security-relevant actions (`/api/v1/system/audit`).

## Hardening checklist (ongoing)

- [x] Hash API keys + passwords
- [x] Redact credentials in native API responses
- [x] Admin-gate config/metadata/users/notifications writes
- [x] Security response headers
- [x] Rate limit sensitive writes
- [x] Correlation IDs + audit log
- [ ] JWT + Plex/Jellyfin login sessions (deferred M8 follow-up)
- [ ] Refreshable/rotatable API keys + scope enforcement beyond `*`
- [ ] CSRF review if cookie sessions are added; strict `SameSite` cookies
- [ ] Secrets manager integration (e.g., Vault) for `MEDIA_NEXUS_SECRET`
- [ ] Third-party dependency auditing (`npm audit` / Dependabot) as part of CI

> Flag (not legal): the compatibility layer reproduces public API wire shapes; it does not imply endorsement of Sonarr/
> Radarr/Prowlarr/Seerr trademarks (see docs/legal/upstream-licenses.md).
