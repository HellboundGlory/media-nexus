# MediaNexus — Provenance Record

This file tracks provenance for anything related to upstream projects (Sonarr, Radarr, Prowlarr, Seerr). Rule: if it's not
here, it must be treated as "reimplemented against documented behavior" and must never have been copied from GPL-3.0
sources.

## Policy

1. **Never copy GPL-3.0 source** (Sonarr/Radarr/Prowlarr) into this repo.
2. Seerr (MIT) may be adapted, but any direct source adaptation is logged here with attribution.
3. Public protocol specs (Newznab, Torznab, Cardigann YAML format, X-Api-Key convention, documented REST endpoint shapes)
   are treated as *interoperability facts* and reimplemented.
4. Every new file MUST carry the SPDX `MIT` header (see `CONTRIBUTING`).

## Provenance log

| File / module (in this repo) | Derived from | Category | License impact | Status |
|---|---|---|---|---|
| (scaffold, date of first commit) — domain model, docs, packages, apps | None (original work informed by public specs + docs listed in `upstream-licenses.md`) | Original | MIT | Active |
| `packages/integrations` provider contracts | Reimplemented from documented protocols (Newznab/Torznab specs, SABnzbd/qBittorrent API docs) | Reimplemented | MIT | Active |
| `apps/api` / `packages/*` | Original TypeScript; API shapes modeled on documented public OpenAPI of _arr apps (behavioral, not code) | Merely compatible / original | MIT | Active |
| Planned: Sonarr/Radarr/Prowlarr/Seerr compat adapters (`packages/compatibility`) | Wire-shape interop against public OpenAPI/docs | Merely compatible | MIT | Planned — record here when landed |
| Planned: Plex/Jellyfin auth flow | Pattern influence from Seerr (MIT) | Adapted pattern (no source text) | MIT (attribution noted) | Planned — record adaptations here |
| Cardigann YAML interpreter (`packages/integrations/src/cardigann.ts`) | Format spec (documented schema); own parser/runtime | Reimplemented format | MIT | Active — never port Prowlarr engine code |

## Attribution

- Seerr (MIT) project: conceptual basis for the Requests/Users/Media-Availability/Notification-subscription model.
  Repository: <https://github.com/seerr-team/seerr>. No source text copied into MediaNexus as of this record.
- Upstream API/protocol documentation referenced: Sonarr/Radarr/Prowlarr public repos & docs; Newznab
  (<https://newznab.readthedocs.io>); Torznab (community spec); Cardigann format docs.
