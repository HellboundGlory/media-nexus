// SPDX-License-Identifier: MIT
/**
 * SON-025/RAD-010 — non-destructive remap of every persisted quality id from the OLD
 * 2D registry (6 resolutions × 6 sources = 36 ids, id = resIdx*6 + srcIdx) to the NEW
 * 3D registry (6 × 8 × 3 = 144 ids, modifier axis added, web split into webdl/webrip).
 *
 * WHY a startup backfill and not a `.sql` migration: the new ids come from the new
 * registry's arithmetic, which lives in `packages/domain/src/quality.ts` and is consumed
 * by `seedStatic` (which must run AFTER this so the ~108 newly-representable rows don't
 * collide with the remapped old rows). The OLD arrays/formula are pinned here as local
 * constants (NOT imported from the live quality.ts, which has already changed) so the
 * decode step is stable forever.
 *
 * Idempotent + non-destructive, gated by a `meta.qualityId3dRemap` setting sentinel
 * (the same pattern as `runSecretBackfill`/`runSettingsBlobBackfill`): runs once after
 * migrations, before `seedStatic`, and never again.
 */
import { eq } from "drizzle-orm";
import { qualityId, type Quality, type QualitySource, type Resolution } from "@medianexus/domain";
import { schema, type Db } from "@medianexus/database";

// --- The OLD registry exactly as it existed pre-RAD-010 (pinned for stable decode) ---
const OLD_RESOLUTION_ORDER: Resolution[] = ["unknown", "480p", "576p", "720p", "1080p", "2160p"];
const OLD_SOURCE_ORDER: QualitySource[] = ["unknown", "sd", "dvd", "hdtv", "web", "bluray"];
const OLD_SOURCE_COUNT = OLD_SOURCE_ORDER.length; // 6

const SENTINEL_KEY = "meta.qualityId3dRemap";

export interface QualityIdBackfillResult {
  skipped: boolean;
  profilesUpdated: number;
  definitionsMoved: number;
}

/** Decode an old 2D id back to its (source, resolution) pair, or null if it isn't a
 *  valid old-registry id (it's either already in the new space or corrupt). */
function decodeOldId(id: number): { source: QualitySource; resolution: Resolution } | null {
  if (!Number.isInteger(id) || id < 0) return null;
  const resIdx = Math.floor(id / OLD_SOURCE_COUNT);
  const srcIdx = id % OLD_SOURCE_COUNT;
  if (resIdx >= OLD_RESOLUTION_ORDER.length || srcIdx >= OLD_SOURCE_COUNT) return null;
  return { source: OLD_SOURCE_ORDER[srcIdx], resolution: OLD_RESOLUTION_ORDER[resIdx] };
}

/** Re-encode an old (source, resolution) pair into the NEW 3D id, modifier=none (nothing
 *  had a modifier before). Uses the LIVE registry's `qualityId`, which is exactly what the
 *  rest of the app now computes — this guarantees the remap lands on the same ids the new
 *  code produces. */
function encodeNewId(src: { source: QualitySource; resolution: Resolution }): number {
  return qualityId({ source: src.source, resolution: src.resolution, edition: "", modifier: "none" } as Quality);
}

export async function runQualityIdBackfill(db: Db): Promise<QualityIdBackfillResult> {
  const sentinel = await db.select().from(schema.setting).where(eq(schema.setting.key, SENTINEL_KEY)).limit(1);
  if (sentinel.length) return { skipped: true, profilesUpdated: 0, definitionsMoved: 0 };

  let profilesUpdated = 0;
  let definitionsMoved = 0;
  const now = new Date().toISOString();

  // --- quality_profile.items[] + cutoffQualityId ---
  const profiles = await db.select().from(schema.qualityProfile);
  for (const p of profiles) {
    let changed = false;
    const items = (p.items ?? []).map((id) => {
      const dec = decodeOldId(id);
      if (!dec) return id;
      const nid = encodeNewId(dec);
      if (nid !== id) changed = true;
      return nid;
    });
    let cutoff = p.cutoffQualityId;
    const cutoffDec = decodeOldId(p.cutoffQualityId);
    if (cutoffDec) {
      const nid = encodeNewId(cutoffDec);
      if (nid !== cutoff) { cutoff = nid; changed = true; }
    }
    if (changed) {
      await db.update(schema.qualityProfile).set({ items, cutoffQualityId: cutoff }).where(eq(schema.qualityProfile.id, p.id));
      profilesUpdated++;
    }
  }

  // --- quality_definition.id (integer PK). Delete + re-insert keeps each row's size data
  // while moving to the new id without PK collisions (a destination id may equal another
  // row's current id). No FK references quality_definition.id (see schema comment).
  const defs = await db.select().from(schema.qualityDefinition);
  for (const d of defs) {
    const dec = decodeOldId(d.id);
    if (!dec) continue;
    const nid = encodeNewId(dec);
    if (nid === d.id) continue;
    await db.delete(schema.qualityDefinition).where(eq(schema.qualityDefinition.id, d.id));
    await db.insert(schema.qualityDefinition).values({
      id: nid, title: d.title, minSize: d.minSize, maxSize: d.maxSize,
      preferredSize: d.preferredSize, updatedAt: d.updatedAt ?? now,
    });
    definitionsMoved++;
  }

  await db.insert(schema.setting).values({ key: SENTINEL_KEY, value: "1", updatedAt: now });
  return { skipped: false, profilesUpdated, definitionsMoved };
}
