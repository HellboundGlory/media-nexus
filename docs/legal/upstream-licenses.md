# MediaNexus — Upstream Licenses & Provenance

> **Not legal advice.** This is an engineering document capturing the licensing analysis that drives *how* we build. Where
> there is ambiguity it is flagged, not guessed. Final review by counsel is recommended before shipping code that derives
> from upstream.

## 1. Upstream projects

| Project | License | Backend language | Relationship to MediaNexus code |
|---|---|---|---|
| Sonarr | **GPL-3.0** | C# | Behavior/API reimplemented; **no source copied** |
| Radarr | **GPL-3.0** | C# | Behavior/API reimplemented; **no source copied** |
| Prowlarr | **GPL-3.0** | C# | Behavior/API reimplemented; **no source copied** |
| Seerr | **MIT** | TypeScript | Patterns/architecture may be adapted with attribution; **no wholesale copying** |

Verified from each repository's LICENSE / package metadata (GitHub API) on the date of this document:
Sonarr/Radarr/Prowlarr = GPL-3.0 (C#), Seerr = MIT (TypeScript). See `overview.md` §2 for the verification table.

## 2. Our licensing choice

MediaNexus is licensed **MIT** (see root `LICENSE`). Why:

- Projects that copy or link GPL-3.0 code must themselves ship under GPL-3.0. Since we deliberately do **not** copy the
  GPL _arr codebases (they are C#; copying would also import a rigid, legacy-coupled architecture — see
  `technology-decisions.md` ADR-001), we are free to choose a permissive license and keep the platform broadly usable —
  including in commercial, self-hosted products.
- MIT also matches Seerr (the one MIT upstream), so adaptation of Seerr-influenced **patterns** (request workflow, media
  availability, notification subscription) carries no copyleft contamination.

## 3. What is "copied/adapted" vs "reimplemented" vs "merely compatible"

For each category below, `docs/legal/provenance.md` is where we record the fine-grained provenance of specific files.

### a) Reimplemented behavior (no source reuse) — Sonarr, Radarr, Prowlarr

- Feature behavior, workflow logic, and *public API shapes* are reimplemented against **documented** behavior: official
  Swagger/OpenAPI outputs (`Sonarr.Api.V3/V5`, `Radarr.Api.V3`, `Prowlarr.Api.V1` publish `openapi.json`), REST doc pages,
  and widely documented community specs (Newznab, Torznab, Cardigann definition format — all public protocol
  specifications).
- API endpoint shapes and protocol wire formats are **functional facts**, not creative expression; implementing a compatible
  interface is the "merely compatible" category below. We nonetheless prefer writing our own implementations rather than
  transcribing upstream code.
- **We do NOT copy any Sonarr/Radarr/Prowlarr source files, entity classes, or service implementations.** If a future
  maintainer ever wants to *port* specific GPL logic, that port and its license implications must be reviewed first
  (project policy: raise a flag, get legal review — do not silently port GPL code into an MIT codebase).

### b) Adaptable with attribution — Seerr (MIT)

- Seerr is MIT, so adapting its patterns (Express app layout, TypeORM-style entities → Drizzle, request approval state
  machine, Plex/Jellyfin auth flow, notification subscription model) is permitted with attribution.
- Policy: we adapt **patterns and contracts**, and if any direct Seerr source text is ever included, we will carry the MIT
  notice and record provenance in `provenance.md`. To date the scaffold contains **no** direct Seerr source text.

### c) Merely compatible (interoperability)

- Serving `X-Api-Key`-authenticated endpoints shaped like Sonarr/Radarr/Prowlarr/Seerr APIs, and talking Newznab/Torznab
  protocols, is interoperability with documented interfaces. This is the Compatibility Layer's role
  (`compatibility.md`) and is cleanly separated from the native domain model.

## 4. Obligations & compliance checklist (ongoing)

- [ ] Root `LICENSE` (MIT) present; every file carries SPDX `MIT` marker in headers for new files.
- [ ] `docs/legal/provenance.md` maintained whenever any upstream-derived content is introduced.
- [ ] No GPL-3.0 source files added to this repository (enforced by convention in CODEOWNERS/review + CI note).
- [ ] Cardigann is reimplemented as a **format** interpreter, not a port of Prowlarr's YAML engine.
- [ ] If docker/distribution ever bundles upstream binaries for *interop testing only*, they must be confined to CI/dev
  fixtures and documented (GPL applies to distribution of GPL code; test-only local use is a separate concern — flag for
  review before publishing test images).

## 5. Flags / ambiguities (do not guess — escalate)

1. **API-shape replication**: reimplementing Sonarr/Radarr/Prowlarr endpoint shapes for interop is standard in this
   ecosystem (several open-source projects do this), but exact conversational UI/text should not be copied.
2. **Trademarks**: "Sonarr", "Radarr", "Prowlarr", "Overseerr"/"Seerr" names and logos are trademarks of their owners;
   the compatibility layer must not imply endorsement. Use distinct naming ("Sonarr-compatible API") in UI/docs.
3. **Cardigann format**: Prowlarr documents it as schema (YAML) — reimplementing a parser is format interop; if any
   schema JSON/definitions file is pulled verbatim from Prowlarr-hosted repos, that is its own provenance decision
   (Flag: schema data vs creative source is a gray area — keep definitions in our own curated store).
