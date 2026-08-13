// SPDX-License-Identifier: MIT
/**
 * Shared library folder-naming convention. One implementation, used by both the import
 * engine (`acquisition.service.ts`, P0.5) and disk scan (`library-scan.service.ts`, P0.6) —
 * a file the app writes during import must be found again by a later scan, and a scan
 * matching a migrated library depends on the same "Title (Year)" folder shape *arr apps
 * already default to, so the two must never drift into two conventions.
 *
 * This is deliberately not the general file-naming system (`media.naming`, gap report B7,
 * roadmap P1) — that's user-configurable templates for the actual media *filename*. This is
 * the fixed folder-per-title convention both import and scan need to agree on regardless.
 */
export function sanitizeTitle(title: string): string {
  return title.replace(/[^A-Za-z0-9 _()[\]-]/g, "").trim();
}

export function movieFolderName(title: string, releaseDate?: string | null): string {
  const safe = sanitizeTitle(title) || "Unknown";
  const year = releaseDate ? releaseDate.slice(0, 4) : "Unknown";
  return `${safe} (${year})`;
}

export function seriesFolderName(title: string): string {
  return sanitizeTitle(title) || "Series";
}
