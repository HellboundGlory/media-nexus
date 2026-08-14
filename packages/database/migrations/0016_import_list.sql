CREATE TABLE `import_list` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`config` text NOT NULL,
	`last_synced_at` text,
	`last_error` text,
	`created_at` text,
	`updated_at` text
);
--> statement-breakpoint
CREATE TABLE `import_exclusion` (
	`id` text PRIMARY KEY NOT NULL,
	`media_type` text NOT NULL,
	`external_id` text NOT NULL,
	`reason` text,
	`created_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_exclusion_media_ext_idx` ON `import_exclusion` (`media_type`, `external_id`);
