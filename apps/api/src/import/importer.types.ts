// SPDX-License-Identifier: MIT
/** Shared planner types + the import target (MediaNexus Db). */
import type { Db } from "@medianexus/database";

export interface ImportReport {
  kind: string;
  sourceTables: string[];
  qualityProfiles: number;
  series: number;
  seasons: number;
  episodes: number;
  movies: number;
  indexers: number;
  history: number;
  remapped: number;   // items updated in place (idempotent re-run)
  skipped: number;    // items already present
  unknown: number;    // rows we could not map
  errors: string[];
  note?: string;
}

export type ImportKind = "sonarr" | "radarr" | "prowlarr";

/** A mapper reads an upstream schema and writes unified rows into the target Db. */
export interface Importer {
  readonly kind: ImportKind;
  /** true if this source DB has the tables this importer expects */
  matches(tables: string[]): boolean;
  run(source: SourceDb, target: Db): Promise<ImportReport>;
}

/** Read access to the upstream sqlite file (better-sqlite3). */
export interface SourceDb {
  tables(): string[];
  /** all rows for a table (empty on missing) */
  all(table: string): ImportRow[];
  /** aggregate count helper */
  count(table: string): number;
}
export type ImportRow = Record<string, unknown>;

export const emptyReport = (kind: string): ImportReport => ({
  kind, sourceTables: [], qualityProfiles: 0, series: 0, seasons: 0, episodes: 0, movies: 0, indexers: 0,
  history: 0, remapped: 0, skipped: 0, unknown: 0, errors: [],
});
