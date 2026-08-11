// SPDX-License-Identifier: MIT
/** Sonarr SQLite -> unified model importer. */
import { eq } from "drizzle-orm";
import { schema, type Db } from "@medianexus/database";
import type { Importer, SourceDb, ImportReport, ImportRow } from "../importer.types";
import { emptyReport } from "../importer.types";
import { str, num, bool, jsonc } from "../rows";
import { importQualityProfiles, importIndexers, importHistory } from "./common";

const iso = (n?: number) => new Date(n ?? Date.now()).toISOString();

export const sonarrImporter: Importer = {
  kind: "sonarr",
  matches: (tables) => new Set(tables).has("Series") && new Set(tables).has("Episodes"),

  async run(source: SourceDb, target: Db): Promise<ImportReport> {
    const report = emptyReport("sonarr");
    report.sourceTables = source.tables();

    // quality profiles
    const qp = await importQualityProfiles(source, target, "QualityProfiles", "q");
    report.qualityProfiles = qp.count; report.skipped += qp.skipped;

    // series + seasons + episodes
    const seriesRows = source.all("Series");
    const seasonRows = source.all("Seasons");
    const episodeRows = source.all("Episodes");
    const seasonBySeries = new Map<number, ImportRow[]>();
    for (const s of seasonRows) {
      const sid = num(s, "SeriesId"); if (sid == null) continue;
      (seasonBySeries.get(sid) ?? seasonBySeries.set(sid, []).get(sid)!).push(s);
    }
    for (const row of seriesRows) {
      const id = num(row, "Id"); if (id == null) { report.unknown++; continue; }
      const derivedId = `imp_s${id}`;
      const existing = await target.select().from(schema.series).where(eq(schema.series.id, derivedId)).limit(1);
      if (existing[0]) { report.skipped++; continue; }
      try {
        await target.insert(schema.series).values({
          id: derivedId,
          tvdbId: num(row, "TvdbId") ?? null,
          imdbId: str(row, "ImdbId") ?? null,
          title: str(row, "Title") ?? `Series ${id}`,
          overview: str(row, "Overview") ?? "",
          status: (str(row, "Status") ?? "unknown").toLowerCase(),
          seriesType: (str(row, "SeriesType") ?? "standard").toLowerCase(),
          network: str(row, "Network") ?? null,
          firstAirYear: num(row, "FirstAired") ? new Date(num(row, "FirstAired")!).getFullYear() : null,
          monitored: bool(row, "Monitored", true),
          qualityProfileId: num(row, "QualityProfileId") ? `imp_q${num(row, "QualityProfileId")}` : null,
          rootFolderPath: str(row, "Path") ?? "/data/media",
          genres: jsonc<unknown[]>(row, "Genres", [] as never).map(String),
          images: jsonc<Record<string, string>[]>(row, "Images", []),
          tags: jsonc<unknown[]>(row, "Tags", []).map(String),
          addedAt: iso(num(row, "Added")),
          updatedAt: iso(),
        }).onConflictDoNothing();
        report.series++;
      } catch (err) { report.errors.push(`series ${id} for DP-map: ${(err as Error).message}`); report.unknown++; continue; }

      // availability row
      await target.insert(schema.mediaAvailability).values({ id: `imp_av_s${id}`, mediaType: "series", mediaId: derivedId, status: "unknown" }).onConflictDoNothing();

      // seasons + episodes
      for (const s of seasonBySeries.get(id) ?? []) {
        const seasonNumber = num(s, "SeasonNumber");
        if (seasonNumber == null) continue;
        const seasonId = `imp_s${id}_se${seasonNumber}`;
        await target.insert(schema.season).values({
          id: seasonId, seriesId: derivedId, seasonNumber, monitored: bool(s, "Monitored", true),
        }).onConflictDoNothing();
        report.seasons++;
        for (const e of episodeRows) {
          if (num(e, "SeasonNumber") !== seasonNumber) continue;
          // integrate with explicit SeriesId match when present
          if (num(e, "SeriesId") != null && num(e, "SeriesId") !== id) continue;
          const epNum = num(e, "EpisodeNumber"); if (epNum == null) continue;
          const airDateRaw = num(e, "AirDateUtc") ?? num(e, "AirDate");
          await target.insert(schema.episode).values({
            id: `imp_s${id}_ep${seasonNumber}_${epNum}`,
            seriesId: derivedId, seasonId,
            episodeNumber: epNum,
            absoluteNumber: num(e, "AbsoluteEpisodeNumber") ?? null,
            title: str(e, "Title") ?? "",
            overview: str(e, "Overview") ?? "",
            airDateUtc: airDateRaw ? new Date(airDateRaw).toISOString() : null,
            monitored: bool(e, "Monitored", true),
            hasFile: bool(e, "HasFile", false),
            sceneSeasonNumber: num(e, "SceneSeasonNumber") ?? null,
            sceneEpisodeNumber: num(e, "SceneEpisodeNumber") ?? null,
          }).onConflictDoNothing();
          report.episodes++;
        }
      }
    }

    // history
    const histIdx = new Map<number, ImportRow>();
    for (const h of source.all("History")) {
      const hid = num(h, "Id"); if (hid != null) histIdx.set(hid, h);
    }
    const hres = await importHistory(source, target, "History", "son", {
      mediaType: "series",
      mediaIdOf: (r) => {
        const sid = num(r, "SeriesId") ?? num(r, "EpisodeId");
        return sid != null ? `imp_s${sid}` : undefined;
      },
    });
    report.history = hres.count; report.skipped += hres.skipped;

    // indexers (Sonarr can host its own indexers)
    if (source.tables().includes("Indexers")) {
      const ix = await importIndexers(source, target, "Indexers", "idx");
      report.indexers = ix.count; report.skipped += ix.skipped;
    }
    return report;
  },
};

