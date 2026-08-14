CREATE TABLE `custom_format` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`specs` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `custom_format_name_unique` ON `custom_format` (`name`);
--> statement-breakpoint
ALTER TABLE `quality_profile` ADD `format_scores` text DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE `quality_profile` ADD `min_format_score` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `quality_profile` ADD `cutoff_format_score` integer DEFAULT 0 NOT NULL;
