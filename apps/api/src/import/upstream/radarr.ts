// SPDX-License-Identifier: MIT
/** Radarr SQLite -> unified model importer. */
import { eq } from "drizzle-orm";
import { schema, type Db } from "@medianexus/database";
import type { Importer, SourceDb, ImportReport } from "../importer.types";
import { emptyReport } from "../importer.types";
import { col, str, num, bool, jsonc } from "../rows";
import { importQualityProfiles, importIndexers, importHistory } from "./common";

const iso = (n?: number) => new Date(n ?? Date.now()).toISOString();

export const radarrImporter: Importer = {
  kind: "radarr",
  matches: (tables) => new Set(tables).has("Movies"),

  async run(source: SourceDb, target: Db): Promise<ImportReport> {
    const report = emptyReport("radarr");
    report.sourceTables = source.tables();

    const qp = await importQualityProfiles(source, target, "QualityProfiles", "q");
    report.qualityProfiles = qp.count; report.skipped += qp.skipped;

    for (const row of source.all("Movies")) {
      const id = num(row, "Id"); if (id == null) { report.unknown++; continue; }
      const derivedId = `imp_m${id}`;
      const existing = await target.select().from(schema.movie).where(eq(schema.movie.id, derivedId)).limit(1);
      if (existing[0]) { report.skipped++; continue; }
      const releaseRaw = col(row, "ReleaseDate") ?? col(row, "Year");
      await target.insert(schema.movie).values({
        id: derivedId,
        tmdbId: num(row, "TmdbId") ?? null,
        imdbId: str(row, "ImdbId") ?? null,
        title: str(row, "Title") ?? `Movie ${id}`,
        originalTitle: str(row, "OriginalTitle") ?? null,
        overview: str(row, "Overview") ?? "",
        status: (str(row, "Status") ?? "unknown").toLowerCase(),
        releaseDate: releaseRaw ? (typeof releaseRaw === "number" ? `${releaseRaw}-01-01` : String(releaseRaw)) : null,
        monitored: bool(row, "Monitored", true),
        qualityProfileId: num(row, "QualityProfileId") ? `imp_q${num(row, "QualityProfileId")}` : null,
        rootFolderPath: str(row, "Path") ?? "/data/media",
        minimumAvailability: str(row, "MinimumAvailability") ?? "announced",
        genres: jsonc<unknown[]>(row, "Genres", [] as never).map(String),
        images: jsonc<Record<string, string>[]>(row, "Images", []),
        tags: jsonc<unknown[]>(row, "Tags", []).map(String),
        hasFile: bool(row, "HasFile", false),
        addedAt: iso(num(row, "Added")),
        updatedAt: iso(),
      }).onConflictDoNothing();
      report.movies++;
      await target.insert(schema.mediaAvailability).values({ id: `imp_av_m${id}`, mediaType: "movie", mediaId: derivedId, status: "unknown" }).onConflictDoNothing();
    }

    const hres = await importHistory(source, target, "History", "rad", {
      mediaType: "movie",
      mediaIdOf: (r) => { const mid = num(r, "MovieId"); return mid != null ? `imp_m${mid}` : undefined; },
    });
    report.history = hres.count; report.skipped += hres.skipped;

    if (source.tables().includes("Indexers")) {
      const ix = await importIndexers(source, target, "Indexers", "idx");
      report.indexers = ix.count; report.skipped += ix.skipped;
    }
    return report;
  },
};
