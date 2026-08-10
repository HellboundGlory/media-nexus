CREATE TABLE `media_server` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`implementation` text NOT NULL,
	`kind` text DEFAULT 'media' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`settings` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `request_item` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`series_id` text,
	`season_number` integer NOT NULL,
	`episode_numbers` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `request_item_req_idx` ON `request_item` (`request_id`);--> statement-breakpoint
CREATE TABLE `user_content_blocklist` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`media_type` text NOT NULL,
	`media_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `blocklist_unique_idx` ON `user_content_blocklist` (`user_id`,`media_type`,`media_id`);--> statement-breakpoint
CREATE TABLE `watchlist` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`media_type` text NOT NULL,
	`media_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `watchlist_unique_idx` ON `watchlist` (`user_id`,`media_type`,`media_id`);