# MediaNexus — Domain Event Architecture

## 1. Purpose

Domain events decouple modules: one module publishes "something happened", others react (notifications, automation,
audit, integrations, jobs). They are used where cross-module signalling provides real value — **not** for every method
call (Rule/anti-pattern in the brief).

Example event catalog (native events; the full list grows as milestones land):

```text
MovieAdded, SeriesAdded, MovieRemoved, SeriesRemoved,
ReleaseFound?, ReleaseGrabbed, DownloadStarted, DownloadCompleted, ImportCompleted,
MediaFileRenamed, IndexerFailed, DownloadClientFailed
```

(`?` = sampled/logged, not necessarily an event consumers act on.)

## 2. Envelope & correlation

```ts
interface DomainEvent {
  id: string          // ulid/uuid
  type: string        // e.g. 'media.movie.added'
  occurredAt: string  // ISO
  correlationId: string  // from the triggering HTTP request/job
  aggregate: { mediaType?: 'movie'|'series'; id?: string; requestId?: string; jobRunId?: string }
  payload: Record<string, unknown>
  version: number
}
```

`correlationId` ties a user click → API request → job run → events → audit rows together. This is the spine of
async-flow debuggability (Rule/observability).

## 3. Transport: in-process bus now, durable outbox later

- **Now:** a framework-agnostic in-process `EventBus` (`packages/events`) with typed subscribe/emit, synchronous +
  `setImmediate` dispatch, and error isolation (a failing listener never breaks the publisher).
- **Persistence now:** a built-in **AuditListener** writes security/admin-relevant events to `audit_log` (async, best
  effort but durable within a transaction when the audit row and the domain write share the DB). Important events are
  audited at the *write call site* too, so audit is not dependent on listener ordering.
- **Later (roadmap):** outbox pattern (events materialized in DB with the originating transaction) → relay → Redis
  Streams/NATS for cross-process delivery. The envelope is versioned so this swap is invisible to producers/consumers.

## 4. Consumers

| Consumer | Behavior |
|---|---|
| Audit log | persist a fixed set of events: `media.movie.added/removed`, `media.series.added/removed`, `system.job.manual` |
| Notifications | webhook / Discord / Telegram / Email sinks subscribe per event type (`acquisition.release.grabbed`, `acquisition.import.completed`, `discovery.indexer.failed`, `acquisition.client.failed`); dispatch async with error isolation + manual `test` endpoint |
| Compatibility/webhooks | future push webhooks subscribed to events |

## 5. Scaffold reality check

In the scaffold: `packages/events` implements the envelope + typed bus + serialization + tests; the API publishes
`MovieAdded`/`SeriesAdded`/`MovieRemoved`/`SeriesRemoved` on create/delete; an `AuditListener` persists those (plus
`system.job.manual`); acquisition/discovery events (`ReleaseGrabbed`, `ImportCompleted`, `IndexerFailed`,
`DownloadClientFailed`) drive the notification sinks.

## 6. Rules

- Events carry **facts** (past tense, immutable), not instructions; consequences are computed by subscribers/jobs.
- No event for trivial internal reads — envelope overhead is reserved for cross-module signalling and audit.
- Publishers never await slow subscribers; dispatch is fire-and-forget with error isolation.
