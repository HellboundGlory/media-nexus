CREATE TABLE `collection` (
	`id` text PRIMARY KEY NOT NULL,
	`tmdb_id` integer NOT NULL,
	`name` text NOT NULL,
	`overview` text,
	`images` text DEFAULT '[]' NOT NULL,
	`monitored` integer DEFAULT false NOT NULL,
	`quality_profile_id` text,
	`root_folder_path` text DEFAULT '' NOT NULL,
	`minimum_availability` text DEFAULT 'released' NOT NULL,
	`search_on_add` integer DEFAULT false NOT NULL,
	`parts` text DEFAULT '[]' NOT NULL,
	`last_sync_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`quality_profile_id`) REFERENCES `quality_profile`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collection_tmdb_idx` ON `collection` (`tmdb_id`);