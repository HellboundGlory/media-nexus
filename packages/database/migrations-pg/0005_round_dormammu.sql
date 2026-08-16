-- roadmap J3 (gap report J3): drop the media_file.episode_ids JSON column (pg twin of the
-- SQLite 0005). episode.media_file_id is the single source of coverage truth; the drop is
-- intentional data narrowing (see the SQLite twin's comment for the full rationale).
ALTER TABLE "media_file" DROP COLUMN "episode_ids";