DROP TABLE `request`;--> statement-breakpoint
DROP TABLE `request_item`;--> statement-breakpoint
DROP TABLE `user`;--> statement-breakpoint
DROP TABLE `user_content_blocklist`;--> statement-breakpoint
DROP TABLE `watchlist`;--> statement-breakpoint
DROP INDEX `api_key_user_idx`;--> statement-breakpoint
ALTER TABLE `api_key` DROP COLUMN `user_id`;