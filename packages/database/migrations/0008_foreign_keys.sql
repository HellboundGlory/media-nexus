-- Roadmap P0.7 (gap report I9 / J2): add the six genuinely non-polymorphic foreign keys
-- (with cascades) that the schema has never declared. SQLite has no ALTER TABLE ADD
-- CONSTRAINT, so adding a FK to an already-existing column requires the standard SQLite
-- table-rebuild procedure (create __new_<table> with the FK, copy rows, drop the old
-- table, rename). Tables are rebuilt in dependency order — series before season, season
-- before episode — so no DROP TABLE ever executes while another already-rebuilt table
-- holds a live FK constraint pointing at the table being dropped.
--
-- The polymorphic tables (media_file, download_queue_entry, history_entry,
-- media_availability, blocklist_entry — all keyed by (media_type, media_id) pointing at
-- either movie.id or series.id depending on the discriminator) cannot get a real SQL
-- foreign key; that is a deliberate, documented consequence of keeping movie/series as
-- separate tables, not a gap. download_queue_entry.download_client_id is the one FK-able
-- column on that table (it points at a single non-polymorphic parent, download_client).
CREATE TABLE `__new_series` (
	`id` text PRIMARY KEY NOT NULL,
	`tvdb_id` integer,
	`tmdb_id` integer,
	`imdb_id` text,
	`title` text NOT NULL,
	`overview` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`series_type` text DEFAULT 'standard' NOT NULL,
	`network` text,
	`first_air_year` integer,
	`monitored` integer DEFAULT true NOT NULL,
	`quality_profile_id` text,
	`root_folder_path` text DEFAULT '' NOT NULL,
	`genres` text DEFAULT '[]' NOT NULL,
	`images` text DEFAULT '[]' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`added_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`quality_profile_id`) REFERENCES `quality_profile`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
INSERT INTO `__new_series`(`id`, `tvdb_id`, `tmdb_id`, `imdb_id`, `title`, `overview`, `status`, `series_type`, `network`, `first_air_year`, `monitored`, `quality_profile_id`, `root_folder_path`, `genres`, `images`, `tags`, `added_at`, `updated_at`) SELECT `id`, `tvdb_id`, `tmdb_id`, `imdb_id`, `title`, `overview`, `status`, `series_type`, `network`, `first_air_year`, `monitored`, `quality_profile_id`, `root_folder_path`, `genres`, `images`, `tags`, `added_at`, `updated_at` FROM `series`;--> statement-breakpoint
DROP TABLE `series`;--> statement-breakpoint
ALTER TABLE `__new_series` RENAME TO `series`;--> statement-breakpoint
CREATE UNIQUE INDEX `series_tvdb_idx` ON `series` (`tvdb_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `series_tmdb_idx` ON `series` (`tmdb_id`);--> statement-breakpoint
CREATE TABLE `__new_season` (
	`id` text PRIMARY KEY NOT NULL,
	`series_id` text NOT NULL,
	`season_number` integer NOT NULL,
	`monitored` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`series_id`) REFERENCES `series`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_season`(`id`, `series_id`, `season_number`, `monitored`) SELECT `id`, `series_id`, `season_number`, `monitored` FROM `season`;--> statement-breakpoint
DROP TABLE `season`;--> statement-breakpoint
ALTER TABLE `__new_season` RENAME TO `season`;--> statement-breakpoint
CREATE UNIQUE INDEX `season_series_num_idx` ON `season` (`series_id`,`season_number`);--> statement-breakpoint
CREATE INDEX `season_series_idx` ON `season` (`series_id`);--> statement-breakpoint
CREATE TABLE `__new_episode` (
	`id` text PRIMARY KEY NOT NULL,
	`series_id` text NOT NULL,
	`season_id` text NOT NULL,
	`episode_number` integer NOT NULL,
	`absolute_number` integer,
	`title` text DEFAULT '' NOT NULL,
	`overview` text DEFAULT '' NOT NULL,
	`air_date_utc` text,
	`monitored` integer DEFAULT true NOT NULL,
	`has_file` integer DEFAULT false NOT NULL,
	`scene_season_number` integer,
	`scene_episode_number` integer,
	FOREIGN KEY (`series_id`) REFERENCES `series`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`season_id`) REFERENCES `season`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_episode`(`id`, `series_id`, `season_id`, `episode_number`, `absolute_number`, `title`, `overview`, `air_date_utc`, `monitored`, `has_file`, `scene_season_number`, `scene_episode_number`) SELECT `id`, `series_id`, `season_id`, `episode_number`, `absolute_number`, `title`, `overview`, `air_date_utc`, `monitored`, `has_file`, `scene_season_number`, `scene_episode_number` FROM `episode`;--> statement-breakpoint
DROP TABLE `episode`;--> statement-breakpoint
ALTER TABLE `__new_episode` RENAME TO `episode`;--> statement-breakpoint
CREATE INDEX `episode_series_idx` ON `episode` (`series_id`);--> statement-breakpoint
CREATE INDEX `episode_season_idx` ON `episode` (`season_id`);--> statement-breakpoint
CREATE TABLE `__new_movie` (
	`id` text PRIMARY KEY NOT NULL,
	`tmdb_id` integer,
	`imdb_id` text,
	`title` text NOT NULL,
	`original_title` text,
	`overview` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`release_date` text,
	`monitored` integer DEFAULT true NOT NULL,
	`quality_profile_id` text,
	`root_folder_path` text DEFAULT '' NOT NULL,
	`minimum_availability` text DEFAULT 'announced' NOT NULL,
	`genres` text DEFAULT '[]' NOT NULL,
	`images` text DEFAULT '[]' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`has_file` integer DEFAULT false NOT NULL,
	`added_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`quality_profile_id`) REFERENCES `quality_profile`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
INSERT INTO `__new_movie`(`id`, `tmdb_id`, `imdb_id`, `title`, `original_title`, `overview`, `status`, `release_date`, `monitored`, `quality_profile_id`, `root_folder_path`, `minimum_availability`, `genres`, `images`, `tags`, `has_file`, `added_at`, `updated_at`) SELECT `id`, `tmdb_id`, `imdb_id`, `title`, `original_title`, `overview`, `status`, `release_date`, `monitored`, `quality_profile_id`, `root_folder_path`, `minimum_availability`, `genres`, `images`, `tags`, `has_file`, `added_at`, `updated_at` FROM `movie`;--> statement-breakpoint
DROP TABLE `movie`;--> statement-breakpoint
ALTER TABLE `__new_movie` RENAME TO `movie`;--> statement-breakpoint
CREATE UNIQUE INDEX `movie_tmdb_idx` ON `movie` (`tmdb_id`);--> statement-breakpoint
CREATE TABLE `__new_download_queue_entry` (
	`id` text PRIMARY KEY NOT NULL,
	`media_type` text NOT NULL,
	`media_id` text NOT NULL,
	`download_client_id` text,
	`download_id` text,
	`title` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`remaining_time` integer,
	`error_message` text,
	`data` text DEFAULT '{}' NOT NULL,
	`added_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`download_client_id`) REFERENCES `download_client`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
INSERT INTO `__new_download_queue_entry`(`id`, `media_type`, `media_id`, `download_client_id`, `download_id`, `title`, `status`, `progress`, `size`, `remaining_time`, `error_message`, `data`, `added_at`, `updated_at`) SELECT `id`, `media_type`, `media_id`, `download_client_id`, `download_id`, `title`, `status`, `progress`, `size`, `remaining_time`, `error_message`, `data`, `added_at`, `updated_at` FROM `download_queue_entry`;--> statement-breakpoint
DROP TABLE `download_queue_entry`;--> statement-breakpoint
ALTER TABLE `__new_download_queue_entry` RENAME TO `download_queue_entry`;--> statement-breakpoint
CREATE INDEX `queue_media_idx` ON `download_queue_entry` (`media_type`,`media_id`);
