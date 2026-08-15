-- Roadmap P3 / gap report D5: `last_refreshed_at` — the rotation cursor for the
-- `media.metadataRefresh` job's `refreshMissing()`. Nullable: NULL = never refreshed
-- (all pre-existing rows start NULL). It is written by refreshMovie()/refreshSeries()
-- on a successful metadata refresh and read (ordered ASC, nulls-first) by refreshMissing()
-- so the job advances through the whole library (both media types) instead of re-selecting
-- the same first N rows every run. Deliberately a dedicated column rather than reusing
-- `updated_at`, which is also bumped by edits/imports/scans and so is not a clean
-- "last metadata refresh" marker (a recently-edited title would be wrongly deprioritized).
ALTER TABLE `movie` ADD `last_refreshed_at` text;--> statement-breakpoint
ALTER TABLE `series` ADD `last_refreshed_at` text;
