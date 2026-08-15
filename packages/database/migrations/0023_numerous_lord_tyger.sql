-- Roadmap P3 / gap report J3: `media_file_id` — the indexed back-reference from episode to the
-- covering media_file (the queryable inverse of media_file.episode_ids). Non-null default NULL;
-- ON DELETE SET NULL so deleting a media_file clears the pointer instead of cascading the episode
-- away. drizzle-kit's ALTER emits the REFERENCES clause sans the action; SQLite DOES accept and
-- enforce `ON DELETE SET NULL` on an added column (verified), so write it explicitly here.
ALTER TABLE `episode` ADD `media_file_id` text REFERENCES media_file(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `episode_media_file_idx` ON `episode` (`media_file_id`);
