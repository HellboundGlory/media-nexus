CREATE TABLE `auto_tag` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`remove_tags_automatically` integer DEFAULT false NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`specifications` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
