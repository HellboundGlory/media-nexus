-- Roadmap P0.2 (gap report B4 / bug I4): replace the (source, resolution) grid quality
-- model with an ordered quality registry. See packages/domain/src/quality.ts for the
-- registry itself — id = resolutionIndex * 6 + sourceIndex, where the resolution and
-- source orderings below are RESOLUTION_ORDER / SOURCE_ORDER in that file. The CASE
-- expressions here must stay in lockstep with those arrays; they are frozen at migration
-- time on purpose (a future registry reorder needs its own migration, not an edit to this
-- lookup).
ALTER TABLE `quality_profile` ADD `items` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `quality_profile` ADD `cutoff_quality_id` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `quality_profile` SET `items` = (
	SELECT json_group_array(id) FROM (
		SELECT (
			(CASE json_extract(value, '$.resolution') WHEN 'unknown' THEN 0 WHEN '480p' THEN 1 WHEN '576p' THEN 2 WHEN '720p' THEN 3 WHEN '1080p' THEN 4 WHEN '2160p' THEN 5 ELSE 0 END) * 6
			+ (CASE json_extract(value, '$.source') WHEN 'unknown' THEN 0 WHEN 'sd' THEN 1 WHEN 'dvd' THEN 2 WHEN 'hdtv' THEN 3 WHEN 'web' THEN 4 WHEN 'bluray' THEN 5 ELSE 0 END)
		) AS id
		FROM json_each(`quality_profile`.`allowed`)
		UNION
		SELECT (
			(CASE json_extract(`quality_profile`.`cutoff`, '$.resolution') WHEN 'unknown' THEN 0 WHEN '480p' THEN 1 WHEN '576p' THEN 2 WHEN '720p' THEN 3 WHEN '1080p' THEN 4 WHEN '2160p' THEN 5 ELSE 0 END) * 6
			+ (CASE json_extract(`quality_profile`.`cutoff`, '$.source') WHEN 'unknown' THEN 0 WHEN 'sd' THEN 1 WHEN 'dvd' THEN 2 WHEN 'hdtv' THEN 3 WHEN 'web' THEN 4 WHEN 'bluray' THEN 5 ELSE 0 END)
		)
		ORDER BY id ASC
	)
);--> statement-breakpoint
UPDATE `quality_profile` SET `cutoff_quality_id` = (
	(CASE json_extract(`cutoff`, '$.resolution') WHEN 'unknown' THEN 0 WHEN '480p' THEN 1 WHEN '576p' THEN 2 WHEN '720p' THEN 3 WHEN '1080p' THEN 4 WHEN '2160p' THEN 5 ELSE 0 END) * 6
	+ (CASE json_extract(`cutoff`, '$.source') WHEN 'unknown' THEN 0 WHEN 'sd' THEN 1 WHEN 'dvd' THEN 2 WHEN 'hdtv' THEN 3 WHEN 'web' THEN 4 WHEN 'bluray' THEN 5 ELSE 0 END)
);--> statement-breakpoint
ALTER TABLE `quality_profile` DROP COLUMN `allowed`;--> statement-breakpoint
ALTER TABLE `quality_profile` DROP COLUMN `cutoff`;--> statement-breakpoint
CREATE TABLE `quality_definition` (
	`id` integer PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`min_size` integer,
	`max_size` integer,
	`preferred_size` integer,
	`updated_at` text NOT NULL
);--> statement-breakpoint
ALTER TABLE `season` DROP COLUMN `quality_profile_id`;
