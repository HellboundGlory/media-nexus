// SPDX-License-Identifier: MIT
/**
 * Pure helpers for the rebuilt Manage Files / Manage Episodes modal (MANAGEFILES-1), kept out
 * of the component so the fiddly logic is unit-testable. Mirrors upstream's
 * SelectEpisodeModalContent.onEpisodesSelectWrapper exactly: checked episodes are sorted, then
 * sliced sequentially across the pending files in table order, N per file.
 */
import type { ManageEpisodeRef, QualityRegistryItem } from "../api/types";

/** Split a sorted episode list into equal sequential slices, one per file. Returns [] when the
 *  list can't be divided evenly across `fileCount` (the exact-even-split requirement upstream's
 *  confirm button enforces — the caller validates before applying). */
export function distributeEpisodes(episodes: ManageEpisodeRef[], fileCount: number): ManageEpisodeRef[][] {
  if (fileCount <= 0) return [];
  const sorted = [...episodes].sort((a, b) => a.episodeNumber - b.episodeNumber);
  if (sorted.length % fileCount !== 0) return [];
  const perFile = sorted.length / fileCount;
  const out: ManageEpisodeRef[][] = [];
  for (let i = 0; i < fileCount; i++) {
    out.push(sorted.slice(i * perFile, (i + 1) * perFile));
  }
  return out;
}

/** The canonical quality display title from the quality registry (e.g. "Bluray 1080p Remux"),
 *  never a raw `${source} · ${resolution}` concatenation. Falls back to the registry's
 *  source/resolution labels, then to the raw values, so an out-of-registry quality still
 *  renders something readable. */
export function qualityRegistryTitle(
  quality: { source: string; resolution: string; edition?: string; modifier?: string } | null | undefined,
  registry: QualityRegistryItem[],
): string {
  if (!quality) return "Unknown";
  const key = `${quality.source}:${quality.resolution}:${quality.modifier ?? "none"}`;
  const byKey = new Map(registry.map((r) => [r.key, r.title]));
  const exact = byKey.get(key);
  if (exact) return exact;
  const noModifier = byKey.get(`${quality.source}:${quality.resolution}:none`);
  if (noModifier) return noModifier;
  return quality.resolution ? `${quality.source} · ${quality.resolution}` : quality.source || "Unknown";
}