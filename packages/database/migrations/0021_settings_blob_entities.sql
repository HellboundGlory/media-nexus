-- Roadmap P2 / gap report J4/D7: notification sinks promoted from JSON arrays in the
-- `setting` blob (notifications.webhooks/discord/telegram/email) to a real table with a
-- stable id. `kind` is webhook|discord|telegram|email; `settings` holds the kind-specific
-- fields only; `eventTypes` is hoisted to its own column. Legacy `setting` rows are
-- migrated by settings-blob-backfill.ts on boot (sentinel-gated) — NOT dropped here, so an
-- existing configured sink survives the upgrade.
CREATE TABLE `notification` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`event_types` text DEFAULT '[]' NOT NULL,
	`settings` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
