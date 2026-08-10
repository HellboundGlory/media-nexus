CREATE TABLE `api_key` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`last_used_at` text,
	`expires_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_key_hash_idx` ON `api_key` (`key_hash`);--> statement-breakpoint
CREATE INDEX `api_key_user_idx` ON `api_key` (`user_id`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`correlation_id` text,
	`actor` text DEFAULT 'system' NOT NULL,
	`action` text NOT NULL,
	`entity_type` text,
	`entity_id` text,
	`details` text DEFAULT '{}' NOT NULL,
	`ip` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_created_idx` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `audit_entity_idx` ON `audit_log` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `blocklist_entry` (
	`id` text PRIMARY KEY NOT NULL,
	`media_type` text NOT NULL,
	`media_id` text NOT NULL,
	`indexer_id` text,
	`title` text NOT NULL,
	`torrent_infohash` text,
	`reason` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `download_client` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`implementation` text NOT NULL,
	`kind` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`priority` integer DEFAULT 1 NOT NULL,
	`settings` text NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `download_queue_entry` (
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
	`added_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `queue_media_idx` ON `download_queue_entry` (`media_type`,`media_id`);--> statement-breakpoint
CREATE TABLE `episode` (
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
	`scene_episode_number` integer
);
--> statement-breakpoint
CREATE INDEX `episode_series_idx` ON `episode` (`series_id`);--> statement-breakpoint
CREATE INDEX `episode_season_idx` ON `episode` (`season_id`);--> statement-breakpoint
CREATE TABLE `history_entry` (
	`id` text PRIMARY KEY NOT NULL,
	`media_type` text NOT NULL,
	`media_id` text NOT NULL,
	`action` text NOT NULL,
	`data` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `history_media_idx` ON `history_entry` (`media_type`,`media_id`);--> statement-breakpoint
CREATE INDEX `history_created_idx` ON `history_entry` (`created_at`);--> statement-breakpoint
CREATE TABLE `indexer` (
	`id` text PRIMARY KEY NOT NULL,
	`definition_key` text NOT NULL,
	`name` text NOT NULL,
	`protocol` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`implementation` text NOT NULL,
	`settings` text NOT NULL,
	`proxy` text,
	`priority` integer DEFAULT 25 NOT NULL,
	`status` text DEFAULT 'disabled' NOT NULL,
	`last_error` text,
	`last_sync_at` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `indexer_definition` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`protocol` text NOT NULL,
	`implementation` text NOT NULL,
	`built_in` integer DEFAULT true NOT NULL,
	`capabilities` text DEFAULT '[]' NOT NULL,
	`category_ids` text DEFAULT '[]' NOT NULL,
	`cardigann_yml` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `indexer_definition_key_unique` ON `indexer_definition` (`key`);--> statement-breakpoint
CREATE TABLE `job_definition` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`schedule` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`timeout_ms` integer DEFAULT 60000 NOT NULL,
	`max_retries` integer DEFAULT 2 NOT NULL,
	`retry_backoff_ms` integer DEFAULT 5000 NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`concurrency_limit` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_definition_key_unique` ON `job_definition` (`key`);--> statement-breakpoint
CREATE TABLE `job_run` (
	`id` text PRIMARY KEY NOT NULL,
	`job_key` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`trigger` text DEFAULT 'scheduled' NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`message` text,
	`error` text,
	`payload` text DEFAULT '{}' NOT NULL,
	`result` text,
	`correlation_id` text,
	`due_at` text,
	`started_at` text,
	`finished_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jobrun_key_idx` ON `job_run` (`job_key`);--> statement-breakpoint
CREATE INDEX `jobrun_status_idx` ON `job_run` (`status`);--> statement-breakpoint
CREATE INDEX `jobrun_created_idx` ON `job_run` (`created_at`);--> statement-breakpoint
CREATE TABLE `media_availability` (
	`id` text PRIMARY KEY NOT NULL,
	`media_type` text NOT NULL,
	`media_id` text NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`plex_id` text,
	`jellyfin_id` text,
	`tmdb_rating` integer,
	`tmdb_vote_count` integer,
	`last_availability_sync_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `availability_media_idx` ON `media_availability` (`media_type`,`media_id`);--> statement-breakpoint
CREATE TABLE `media_file` (
	`id` text PRIMARY KEY NOT NULL,
	`media_type` text NOT NULL,
	`media_id` text NOT NULL,
	`episode_ids` text DEFAULT '[]' NOT NULL,
	`relative_path` text NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`quality` text DEFAULT '[]' NOT NULL,
	`media_info` text DEFAULT '[]' NOT NULL,
	`languages` text DEFAULT '[]' NOT NULL,
	`date_added` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `media_file_media_idx` ON `media_file` (`media_type`,`media_id`);--> statement-breakpoint
CREATE TABLE `movie` (
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
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `movie_tmdb_idx` ON `movie` (`tmdb_id`);--> statement-breakpoint
CREATE TABLE `quality_profile` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`allowed` text NOT NULL,
	`cutoff` text NOT NULL,
	`upgrade_allowed` integer DEFAULT true NOT NULL,
	`language` text DEFAULT 'en' NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quality_profile_name_unique` ON `quality_profile` (`name`);--> statement-breakpoint
CREATE TABLE `request` (
	`id` text PRIMARY KEY NOT NULL,
	`user_requestor_id` text,
	`media_type` text NOT NULL,
	`media_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`is_auto_approval` integer DEFAULT false NOT NULL,
	`admin_note` text,
	`requested_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `request_media_idx` ON `request` (`media_type`,`media_id`);--> statement-breakpoint
CREATE INDEX `request_user_idx` ON `request` (`user_requestor_id`);--> statement-breakpoint
CREATE TABLE `season` (
	`id` text PRIMARY KEY NOT NULL,
	`series_id` text NOT NULL,
	`season_number` integer NOT NULL,
	`monitored` integer DEFAULT true NOT NULL,
	`quality_profile_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `season_series_num_idx` ON `season` (`series_id`,`season_number`);--> statement-breakpoint
CREATE INDEX `season_series_idx` ON `season` (`series_id`);--> statement-breakpoint
CREATE TABLE `series` (
	`id` text PRIMARY KEY NOT NULL,
	`tvdb_id` integer,
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
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `series_tvdb_idx` ON `series` (`tvdb_id`);--> statement-breakpoint
CREATE TABLE `setting` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`email` text,
	`password_hash` text,
	`is_admin` integer DEFAULT false NOT NULL,
	`roles` text DEFAULT '[]' NOT NULL,
	`plex_token` text,
	`jellyfin_token` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_username_idx` ON `user` (`username`);