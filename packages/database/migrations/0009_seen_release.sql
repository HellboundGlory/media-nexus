-- Roadmap D2 (real RSS sync): a category-only "recent releases" poll of an indexer
-- returns a heavily-overlapping set on every tick (feeds have a rolling window; polls run
-- every few minutes). This table lets a poll skip re-parsing/re-matching releases it has
-- already evaluated, independent of whether a release ever matched a wanted title — a
-- separate concern from download_queue_entry/history_entry's "don't re-grab this title"
-- dedupe (RssSyncService.hasActiveQueue/grabbedRecently, unchanged by this migration).
CREATE TABLE `seen_release` (
	`id` text PRIMARY KEY NOT NULL,
	`indexer_id` text NOT NULL,
	`guid` text NOT NULL,
	`first_seen_at` text NOT NULL,
	FOREIGN KEY (`indexer_id`) REFERENCES `indexer`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `seen_release_indexer_guid_idx` ON `seen_release` (`indexer_id`,`guid`);--> statement-breakpoint
CREATE INDEX `seen_release_first_seen_idx` ON `seen_release` (`first_seen_at`);