-- roadmap J3 (gap report J3): drop the media_file.episode_ids JSON column. episode.media_file_id
-- (indexed, SET NULL FK) is now the single source of coverage truth — the JSON column was a
-- deliberate temporary dual-write for migration so this drop (the first column drop in this
-- migration chain) is data-narrowing BY DESIGN (Option A): a surviving partially-superseded file's
-- JSON could list an episode whose media_file_id was repointed to a newer file — that stale
-- over-claim is discarded, not reconciled, and there is nothing to backfill into.
ALTER TABLE `media_file` DROP COLUMN `episode_ids`;