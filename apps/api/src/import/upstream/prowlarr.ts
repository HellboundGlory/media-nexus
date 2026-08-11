// SPDX-License-Identifier: MIT
/** Prowlarr SQLite -> unified model importer (indexers). */
import type { Db } from "@medianexus/database";
import type { Importer, SourceDb, ImportReport } from "../importer.types";
import { emptyReport } from "../importer.types";
import { importIndexers } from "./common";

export const prowlarrImporter: Importer = {
  kind: "prowlarr",
  matches: (tables) => new Set(tables).has("Indexers") && !new Set(tables).has("Series"),

  async run(source: SourceDb, target: Db): Promise<ImportReport> {
    const report = emptyReport("prowlarr");
    report.sourceTables = source.tables();
    const ix = await importIndexers(source, target, "Indexers", "idx");
    report.indexers = ix.count; report.skipped += ix.skipped;
    report.unknown += ix.unknownSettings;
    return report;
  },
};
