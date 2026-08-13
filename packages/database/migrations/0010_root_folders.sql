-- Roadmap P1 (gap report B8): promotes the single-array `paths.rootFolders` setting to a
-- real, per-title-assignable root_folder entity (path/name/default, free space probed live
-- at read time, not stored), and adds remote_path_mapping to translate a download client's
-- self-reported content path into the path MediaNexus sees on its own filesystem. Purely
-- additive — the old setting key is dropped from the runtime settings schema in the same
-- change but its row (if present) is simply no longer read; no data migration needed since
-- nothing depended on it beyond a fallback default path.
CREATE TABLE `remote_path_mapping` (
	`id` text PRIMARY KEY NOT NULL,
	`download_client_id` text NOT NULL,
	`remote_path` text NOT NULL,
	`local_path` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`download_client_id`) REFERENCES `download_client`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `remote_path_mapping_client_remote_idx` ON `remote_path_mapping` (`download_client_id`,`remote_path`);--> statement-breakpoint
CREATE INDEX `remote_path_mapping_client_idx` ON `remote_path_mapping` (`download_client_id`);--> statement-breakpoint
CREATE TABLE `root_folder` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `root_folder_path_idx` ON `root_folder` (`path`);