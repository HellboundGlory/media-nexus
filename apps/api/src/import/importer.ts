// SPDX-License-Identifier: MIT
import Database from "better-sqlite3";
import type { Db } from "@medianexus/database";
import type { Importer, ImportKind, ImportReport, SourceDb, ImportRow } from "./importer.types";
import { detectKind } from "./rows";
import { sonarrImporter } from "./upstream/sonarr";
import { radarrImporter } from "./upstream/radarr";
import { prowlarrImporter } from "./upstream/prowlarr";
import { seerrImporter } from "./upstream/seerr";

export const importers: Record<ImportKind, Importer> = {
  sonarr: sonarrImporter,
  radarr: radarrImporter,
  prowlarr: prowlarrImporter,
  seerr: seerrImporter,
};

/** Read access over an upstream sqlite file (better-sqlite3). */
export function openSource(path: string): SourceDb {
  const db = new Database(path, { readonly: true });
  const tables = () => (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
  return {
    tables,
    all: (table) => {
      try { return db.prepare(`SELECT * FROM \`${table}\``).all() as ImportRow[]; }
      catch { return []; }
    },
    count: (table) => { try { return (db.prepare(`SELECT COUNT(*) as n FROM \`${table}\``).get() as { n: number }).n; } catch { return 0; } },
  };
}

/** Determine the importer for a source DB; `kind` can be forced. */
export function pickImporter(tables: string[], kind?: string): Importer | null {
  if (kind && importers[kind as ImportKind]) return importers[kind as ImportKind];
  const detected = detectKind(tables);
  if (detected === "unknown") return null;
  const imp = importers[detected];
  return imp.matches(tables) ? imp : null;
}

/**
 * Import an upstream SQLite database into the MediaNexus target DB.
 * Idempotent (derived already-existing ids are skipped/remapped); reports per-entity counts.
 */
export async function runImport(
  sourcePath: string,
  target: Db,
  opts: { kind?: string; onLog?: (msg: string) => void } = {},
): Promise<ImportReport> {
  const source = openSource(sourcePath);
  const tables = source.tables();
  const importer = pickImporter(tables, opts.kind);
  if (!importer) {
    return {
      kind: opts.kind ?? "unknown", sourceTables: tables, qualityProfiles: 0, series: 0, seasons: 0, episodes: 0,
      movies: 0, indexers: 0, users: 0, requests: 0, watchlists: 0, history: 0, remapped: 0, skipped: 0, unknown: 0,
      errors: [`No importer matched source tables: ${tables.slice(0, 20).join(", ")}`], note: "unsupported database",
    };
  }
  opts.onLog?.(`importing ${importer.kind} from ${sourcePath} (${tables.length} tables)`);
  return importer.run(source, target);
}
