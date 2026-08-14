CREATE TABLE `provider_status` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_type` text NOT NULL,
	`provider_id` text NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`escalation_level` integer DEFAULT 0 NOT NULL,
	`disabled_until` text,
	`auto_disabled` integer DEFAULT false NOT NULL,
	`last_error` text,
	`last_failure_at` text,
	`last_success_at` text,
	`rate_limit` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_status_type_id_idx` ON `provider_status` (`provider_type`, `provider_id`);
