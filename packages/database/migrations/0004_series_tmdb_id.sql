ALTER TABLE `series` ADD `tmdb_id` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `series_tmdb_idx` ON `series` (`tmdb_id`);