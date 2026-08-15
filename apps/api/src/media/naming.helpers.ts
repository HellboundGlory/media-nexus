// SPDX-License-Identifier: MIT
/**
 * Shared library folder-naming convention. One implementation, used by both the import
 * engine (`acquisition.service.ts`, P0.5) and disk scan (`library-scan.service.ts`, P0.6) —
 * a file the app writes during import must be found again by a later scan, and a scan
 * matching a migrated library depends on the same "Title (Year)" folder shape *arr apps
 * already default to, so the two must never drift into two conventions.
 *
 * This is deliberately not the general file-naming system (`media.naming`, gap report B7,
 * roadmap P1) — that's user-configurable templates for the actual media *filename*, built
 * below via `movieFileName`/`episodeFileName`. This file's `movieFolderName`/
 * `seriesFolderName` remain the fixed folder-per-title convention both import and scan need
 * to agree on regardless of the user's naming template.
 */
import type { RuntimeSettings } from "@medianexus/shared";
import { sanitizeForPath, buildMovieFilename, buildEpisodeFilename, type Quality } from "@medianexus/domain";

/** @deprecated kept for the folder-naming call sites below; use `sanitizeForPath` from
 *  `@medianexus/domain` directly for new code. Was a Latin-only whitelist strip that
 *  collapsed any non-Latin title to "" (gap report B7) — now delegates to the
 *  transliterate-then-strip-illegal-chars implementation. */
function sanitizeTitle(title: string): string {
  return sanitizeForPath(title);
}

export function movieFolderName(title: string, releaseDate?: string | null): string {
  const safe = sanitizeTitle(title) || "Unknown";
  const year = releaseDate ? releaseDate.slice(0, 4) : "Unknown";
  return `${safe} (${year})`;
}

export function seriesFolderName(title: string): string {
  return sanitizeTitle(title) || "Series";
}

/** Builds the on-disk movie filename (no extension) from the configured `media.naming`
 *  template. */
export function movieFileName(cfg: RuntimeSettings, title: string, releaseDate: string | null | undefined, quality: Quality): string {
  return buildMovieFilename(cfg["media.naming"].movies, { title, year: releaseDate, quality });
}

/** Builds the on-disk episode filename (no extension) from the configured `media.naming`
 *  template. Multi-episode files use Sonarr's "Range" style (S01E01-02). */
export function episodeFileName(
  cfg: RuntimeSettings,
  seriesTitle: string,
  season: number,
  episodes: { number: number; title: string }[],
  quality: Quality,
): string {
  return buildEpisodeFilename(cfg["media.naming"].episodes, { seriesTitle, season, episodes, quality });
}
