CREATE TABLE `health_check_result` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`ok` integer DEFAULT true NOT NULL,
	`level` text NOT NULL,
	`message` text NOT NULL,
	`checked_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `health_check_result_key_idx` ON `health_check_result` (`key`);
--> statement-breakpoint
-- system.metadataCleanup was seeded (packages/database/src/seed.ts) with no registered
-- handler, so every scheduled run failed with "No handler registered". Roadmap P1 (gap
-- report B9) replaces it with the real system.housekeeping job, reusing its 04:00 daily
-- slot. Hand-written (drizzle-kit only diffs schema, not data) — idempotent, safe to
-- re-run against a DB where the row is already gone.
DELETE FROM `job_definition` WHERE `key` = 'system.metadataCleanup';