// SPDX-License-Identifier: MIT
/**
 * Gap report J3 — idempotent, non-destructive backfill of `episode.media_file_id` from
 * pre-existing `media_file.episode_ids` data.
 *
 * Why this is a startup data pass and not a Drizzle SQL migration: the backfill's source column
 * (`media_file.episode_ids`) holds the JSON array of covered episode ids, and the write sites that
 * populate it only started ALSO writing the new `episode.media_file_id` FK after this feature — so
 * every row that already existed before the migration has the JSON but not the FK. A `.sql`
 * migration could do this with SQL, but doing it here (mirroring the J9 secret-backfill and the J4
 * settings-blob-backfill passes) keeps the two inverse pointers provably in lock-step and lets the
 * bookkeeping live next to the write sites. It runs after `runMigrations()` on boot, only when the
 * row's `media_file_id` is still NULL (the `isNull` guard), so re-running is a no-op and it never
 * overwrites a value the write-path has since set.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { schema, type Db } from "@medianexus/database";

export interface EpisodeMediaFileBackfillResult {
  /** Number of `episode` rows whose `media_file_id` was populated. */
  linked: number;
}

export async function runEpisodeMediaFileBackfill(db: Db): Promise<EpisodeMediaFileBackfillResult> {
  const result: EpisodeMediaFileBackfillResult = { linked: 0 };

  // Every media_file row that names episodes is a candidate; its id becomes those episodes' FK.
  const files = await db.select({
    id: schema.mediaFile.id,
    episodeIds: schema.mediaFile.episodeIds,
  }).from(schema.mediaFile);

  for (const f of files) {
    const ids = f.episodeIds ?? [];
    if (ids.length === 0) continue;
    // Only episodes that don't already have a file pointer — idempotent, never overwrites.
    const pending = await db.select({ id: schema.episode.id })
      .from(schema.episode)
      .where(and(inArray(schema.episode.id, ids), isNull(schema.episode.mediaFileId)));
    for (const ep of pending) {
      await db.update(schema.episode)
        .set({ mediaFileId: f.id })
        .where(eq(schema.episode.id, ep.id));
    }
    result.linked += pending.length;
  }

  return result;
}
