// SPDX-License-Identifier: MIT
/** Defensive helpers for reading arbitrary upstream SQLite rows. */

export type Row = Record<string, unknown>;

/** Read a column if present (returns undefined when missing) — upstream schemas vary. */
export function col<T = unknown>(row: Row, name: string): T | undefined {
  if (!row || typeof row !== "object") return undefined;
  if (!(name in row)) return undefined;
  return (row as Record<string, T>)[name];
}

export function str(row: Row, name: string): string | undefined {
  const v = col(row, name);
  return v == null ? undefined : String(v);
}
export function num(row: Row, name: string): number | undefined {
  const v = col(row, name);
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
export function bool(row: Row, name: string, def = false): boolean {
  const v = col(row, name);
  return v == null ? def : (v === true || v === 1 || v === "1" || v === "true");
}
/** Parse a json column safely. */
export function jsonc<T = unknown>(row: Row, name: string, def: T): T {
  const v = col(row, name);
  if (v == null) return def;
  if (typeof v === "object") return v as T;
  try { return JSON.parse(String(v)) as T; } catch { return def; }
}
export const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Detect which upstream kind a DB is by the tables it has. */
export function detectKind(tables: string[]): "sonarr" | "radarr" | "prowlarr" | "seerr" | "unknown" {
  const t = new Set(tables);
  if (t.has("Series") && t.has("Seasons") && t.has("Episodes")) return "sonarr";
  if (t.has("Movies") && t.has("MovieFiles")) return "radarr";
  if (t.has("Indexers") && t.has("Tags") && !t.has("Series")) return "prowlarr";
  if (t.has("User") && t.has("Media")) return "seerr";
  return "unknown";
}
