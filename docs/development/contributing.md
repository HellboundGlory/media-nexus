# MediaNexus — Contributing

## Ground rules

- **Rule 1 — Research before assumptions**: if a behavior touches upstream behavior (Sonarr/Radarr/Prowlarr/Seerr), read
  the upstream source/docs *first* and reference it in your PR.
- **Rule 2 — Preserve domain boundaries**: compatibility/HTTP concerns never leak into `packages/domain` or domain services.
- **Rule 3 — Prefer interfaces**: new external systems implement a provider contract in `packages/integrations`.
- **Rule 4 — Don't duplicate infrastructure**: if two domains need it, build it once in a package.
- **Rule 5 — Don't prematurely abstract**: add an abstraction only for real shared behavior.
- **Rule 6 — Compat is intentional**: compat adapters are explicit, tested, and documented.
- **Rule 7 — Security by default**: never log/return credentials; secrets encrypted at rest.
- **Rule 8 — Document**: every major decision gets a doc note (see `docs/architecture/`).
- **Rule 9 — Tests**: meaningful functionality has tests.
- **Rule 10 — Runnable**: the repo builds and tests at every stage.

## Licensing & provenance

- The repo is **MIT**. Do **not** copy GPL-3.0 source (Sonarr/Radarr/Prowlarr) into the repo — reimplement against
  documented behavior. If you adapt Seerr (MIT) content, record it in `docs/legal/provenance.md`.
- Every new file carries an SPDX `MIT` header. PRs that port GPL logic are rejected by policy (escalate to maintainers).

## Dev loop

```bash
npm install
npm run lint && npm run typecheck && npm test
npm run dev:api   # in one terminal
npm run dev:web   # in another
```

All workspace packages are TypeScript; `apps/api` and `packages/*` compile to CommonJS; `apps/web` is bundled by Vite.
Formatting: Prettier. Commit messages conventional (feat:, fix:, docs:, chore:).

## Review checklist

- [ ] Domain boundaries respected (no compat/HTTP imports into domain services)
- [ ] Config validated by zod; secrets never echoed
- [ ] Tests added: unit + integration/e2e as appropriate; compat changes add/update a contract test
- [ ] Docs updated (`docs/architecture/*` when behavior/contracts change)
- [ ] `npm run lint && npm run typecheck && npm test` green locally
