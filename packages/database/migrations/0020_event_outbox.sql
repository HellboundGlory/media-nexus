-- Roadmap P2 / gap H6: durable event outbox. Persists every domain event so audit + SSE
-- replay survive crashes/restarts. `seq` is a monotonic autoincrement order key; `id` is the
-- DomainEvent's stable uuid used as the SSE `Last-Event-ID` cursor. aggregate/payload are
-- JSON-serialized (drizzle `json` columns -> TEXT).
CREATE TABLE `event_outbox` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`type` text NOT NULL,
	`version` integer NOT NULL,
	`occurred_at` text NOT NULL,
	`correlation_id` text NOT NULL,
	`aggregate` text NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_outbox_id_idx` ON `event_outbox` (`id`);
--> statement-breakpoint
CREATE INDEX `event_outbox_occurred_idx` ON `event_outbox` (`occurred_at`);
