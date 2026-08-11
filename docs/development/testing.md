# MediaNexus — Testing Strategy

## Layers

| Layer | Tool | Scope / examples |
|---|---|---|
| Unit | Vitest | domain services, parsers, quality evaluation, provider contracts (mocked), release matching, job state machine, event bus |
| Integration | Vitest + supertest against a NestJS app on SQLite | API contract per endpoint: auth, validation, movies/series CRUD, history, queue, jobs (schedule→run→history), events→audit |
| Contract | Vitest | compatibility adapters: request/response snapshots locked to upstream-documented shapes (M6) |
| End-to-end | Playwright | critical journeys (M8): add movie → search → grab → download → import → library |

## Priority workflows (per brief, highest-risk first)

1. Search → Grab → Download → Import → Organize → Library (M1)
2. Auto-grab: RSS sync → Search → Grab → Download → Import (M2)
3. Indexer → Search → Results → Grab (M1/M3)
4. Existing client → Compatibility API → MediaNexus (M6)

## Running

```bash
npm test                 # all unit + e2e
npm test -w @medianexus/api      # api e2e only
npm run test:unit                # packages unit tests
```

## Conventions

- E2E app boots with `NODE_ENV=test` + SQLite file in a temp dir; migrations run before tests; each test suite gets an
  isolated DB.
- Secrets are never asserted in test output; API-key tests assert hashed storage only.
- New contracts (provider wire shapes, compat endpoints) require a fixture + snapshot test.
