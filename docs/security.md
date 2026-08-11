# MediaNexus — Security

This is the security guide + hardening baseline. **This is an engineering document, not a legal or security audit.**

## Trust model

- A self-hosted app owned by the operator. The threat model is: unauthenticated network access, credential leakage,
  secrets in logs/responses, abuse of write endpoints, and credentials on the wire.
- **Two auth paths, one trust tier — still single-tier, no roles/permission tiers.** There are no *multi-user*
  accounts; there's exactly one admin identity, reachable two ways:
  - **Browser: session cookie.** A username/password login (`POST /api/v1/auth/login`, "Forms auth" in
    Sonarr/Radarr's terms) issues an `httpOnly`, `SameSite=Strict` cookie. First run walks you through creating this
    account instead of copying a key out of logs — see `deployment/docker.md`.
  - **External/API clients: `X-Api-Key` header**, unchanged from before — this is what Sonarr/Radarr-compatible
    tooling and scripts use against `/api/v1` and the compat surfaces. Hashed at rest for lookups, plus an
    AES-256-GCM encrypted copy (keyed from `MEDIA_NEXUS_SECRET`) so it can be revealed again from System → API key
    without rotating it.
  - `ApiKeyGuard` tries the header first, falls back to the session cookie if absent — either resolves to the same
    full-access `Principal`.
  - This originally reversed ADR-010's "no login screen, ever" — see `architecture/technology-decisions.md` for the
    reasoning. MediaNexus is still meant to run on a trusted LAN/private network, not exposed to the public internet.

## Authz matrix

| Resource | Reads | Writes | Notes |
|---|---|---|---|
| `/api/v1/movies`, `/series`, `/episode`, `/wanted`, `/calendar`, `/history`, `/queue` | API key or session | API key or session | UI + automation |
| `/api/v1/movies|series/:id/metadata`, `/indexers` (create/delete), `/download-clients`, `/system/config`, `/notifications`, `/media-servers` | API key or session | API key or session | Guarded by `AdminGuard`, which requires `principal.isAdmin` — always `true` for either auth path, so this is a routing convention (write paths are grouped behind the guard) rather than a real permission tier |
| Cross-domain `/api/sonarr|radarr|prowlarr/v1/*` | API key | API key | Compatibility surfaces — session cookies don't apply here, these are consumed by non-browser clients. Prowlarr indexer list intentionally exposes logged-in config (that's the interop contract) — keep native lists redacted (below) |
| `/api/v1/auth/status`, `/setup`, `/login`, `/logout` | public | public | `setup`/`login` are rate-limited (`LoginRateLimitGuard`, 5 attempts/5min/IP); `setup` rejects (409) once an admin account exists |
| `/health/*`, `/metrics` | public | — | liveness/readiness/scrape |

## Secrets handling (implemented)

- API keys stored **hashed (SHA-256)** for auth lookups, plus an **AES-256-GCM encrypted copy** (keyed from
  `MEDIA_NEXUS_SECRET`) so the raw value can be revealed again later from System → API key without rotating it
  (`GET /api/v1/auth/key`, returns the calling key's own value only). Keys minted before this existed have no
  encrypted copy and must be regenerated once to enable reveal.
- Admin password stored as **scrypt** (`packages/shared/src/password.ts`, random salt, `timingSafeEqual` comparison)
  — Node's built-in `crypto`, no bcrypt/argon2 dependency (avoids a second native-compiled dependency in the
  distroless build pipeline; scrypt is an OWASP-approved KDF).
- Session cookies are **stateless and signed**, not a server-side session table: HMAC-SHA256 over `{passwordVersion,
  issuedAt, expiry}`, keyed from a hash of `MEDIA_NEXUS_SECRET` domain-separated from the API-key encryption key
  (`packages/shared/src/session.ts`). Changing the password bumps `passwordVersion`, which invalidates every
  previously-issued cookie — the only way sessions are revoked early; otherwise they expire after 30 days.
- `MEDIA_NEXUS_SECRET` (encryption key) from env or `MEDIA_NEXUS_SECRET_FILE` (Docker secrets). Used for API-key
  encryption and session signing; indexer/download-client/notification credentials are **not yet encrypted at
  rest** (stored as plain JSON in `settings`) — see the hardening checklist below.
- **Native API responses redact credentials**: `redactDeep()`/`redactSettings()` mask field names matching
  `api.?key | apikey | token | secret | password | pass | credential | user | username | chatid` in
  `/indexers`, `/download-clients`, `/system/config` and `/media-servers` responses (compat surfaces that need the
  settings for interop are intentionally separate).
- Structured logger redacts secret-ish fields (`Logger` in `packages/shared`).

## Transport & headers

- MediaNexus does not terminate or expect TLS itself, and there is no `TRUST_PROXY` setting — this app is not meant to
  sit behind a reverse proxy or be exposed to the public internet (see `deployment/docker.md`). If you need TLS for
  LAN/private-network access, use a VPN/overlay network (e.g. Tailscale) rather than a public-facing proxy. The
  session cookie is issued with `Secure` deliberately **unset** to match — forcing it would break cookie delivery
  over plain HTTP.
- API sets: `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer`,
  `X-XSS-Protection: 0`, `Cross-Origin-Opener-Policy: same-origin` (`SecurityHeadersMiddleware`).
- **CSRF**: the session cookie is `SameSite=Strict`, which is the primary defense — there's no legitimate cross-site
  use case for this app, and the existing "no CORS" posture is unchanged. Compat clients aren't affected since they
  authenticate via the `X-Api-Key` header, not the cookie, which isn't subject to ambient-credential CSRF the same way.

## Abuse & protection

- Rate limiting (`RateLimitGuard`, windowed per-IP bucket) on `POST /api/v1/grabs` (single-instance; a Redis-backed
  limiter is the documented scale-out). A tighter, separately-bucketed limit (`LoginRateLimitGuard`, 5/5min/IP)
  guards `POST /api/v1/auth/login` specifically, since it's a brute-force target.
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
- [x] Real login/session auth for the browser (`POST /api/v1/auth/login`, signed httpOnly cookie, rate-limited)
- [ ] Scope enforcement beyond `*` (all keys/sessions remain full-access)
- [ ] Encrypt indexer/download-client/notification credentials at rest (currently plain JSON in `settings`)
- [ ] Secrets manager integration (e.g., Vault) for `MEDIA_NEXUS_SECRET`
- [ ] Third-party dependency auditing (`npm audit` / Dependabot) as part of CI
- [ ] 2FA / "skip auth for local addresses" (real Sonarr/Radarr features, deliberately out of scope for now)

**Lost the admin password?** There's no self-service reset (no email, single account, by design — same reality as
Sonarr/Radarr's own Forms auth). Delete the `admin_credential` row from the database and restart; first-run setup
triggers again. Existing library data, indexers, and the separate API key are untouched.

> Flag (not legal): the compatibility layer reproduces public API wire shapes; it does not imply endorsement of Sonarr/
> Radarr/Prowlarr trademarks (see docs/legal/upstream-licenses.md).
