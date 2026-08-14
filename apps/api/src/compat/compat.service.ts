// SPDX-License-Identifier: MIT
import { Inject, Injectable, Logger } from "@nestjs/common";
import { desc } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import {
  buildSonarrV3SurfaceSource,
  buildRadarrV3Surface,
  buildProwlarrV1Surface,
  type CompatSurface,
  type CompatSeries,
  type CompatMovie,
  type CompatEpisode,
  type CompatQualityProfile,
  type CompatIndexerDef,
  type CompatSearchResult,
} from "@medianexus/compatibility";
import type { SonarrNativeSource } from "@medianexus/compatibility";
import type { RadarrNativeSource } from "@medianexus/compatibility";
import type { ProwlarrNativeSource } from "@medianexus/compatibility";
import { qualityMeta } from "@medianexus/domain";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import { SystemStatusService } from "../system/system-status.service";
import { SeriesService } from "../series/series.service";
import { MoviesService } from "../movies/movies.service";
import { JobsService } from "../jobs/jobs.service";
import { IndexersService } from "../indexers/indexers.service";
import { redactSettings } from "../common/redact";

/** Map our ordered-registry profile shape onto the Sonarr/Radarr wire shape:
 *  `items` become {quality:{id,name},allowed:true} entries, `cutoff` becomes the real
 *  cutoff quality id, and the format-score thresholds come from the profile (previously
 *  hardcoded 0 literals — gap report D6). */
function toCompatQualityProfile(p: typeof schema.qualityProfile.$inferSelect): CompatQualityProfile {
  return {
    id: p.id,
    name: p.name,
    upgradeAllowed: p.upgradeAllowed,
    cutoff: p.cutoffQualityId,
    items: p.items.map((id) => ({ quality: { id, name: qualityMeta(id)?.title ?? "Unknown" }, allowed: true })),
    minFormatScore: p.minFormatScore ?? 0,
    cutoffFormatScore: p.cutoffFormatScore ?? 0,
  };
}

/**
 * Compatibility layer (M6): builds the Sonarr v3 / Radarr v3 / Prowlarr v1 surfaces
 * from real native services and translates response shapes (doc: compat.md).
 * Adapters never touch internal models directly — they go through native services.
 */
@Injectable()
export class CompatService {
  private readonly logger = new Logger(CompatService.name);
  readonly surfaces: CompatSurface[];

  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly statusSvc: SystemStatusService,
    private readonly series: SeriesService,
    private readonly movies: MoviesService,
    private readonly jobs: JobsService,
    private readonly indexers: IndexersService,
  ) {
    this.surfaces = [
      buildSonarrV3SurfaceSource(this.sonarrSource()),
      buildRadarrV3Surface(this.radarrSource()),
      buildProwlarrV1Surface(this.prowlarrSource()),
    ];
  }

  private app(): { version: string; name: string; started: string; db: string } {
    const s = this.statusSvc.status();
    return { version: s.version, name: "MediaNexus", started: s.started, db: "1" };
  }

  // ---------- Sonarr v3 ----------
  private sonarrSource(): SonarrNativeSource {
    const app = this.app();
    return {
      appVersion: () => app.version,
      appName: () => app.name,
      started: () => app.started,
      databaseVersion: () => app.db,
      listSeries: async () => {
        const rows = await this.series.list({});
        const seasonsRows = await this.db.select().from(schema.season).orderBy(desc(schema.season.seasonNumber));
        return rows.items.map((s) => ({
          id: s.id, title: s.title, tvdbId: s.tvdbId, seriesType: s.seriesType || "standard",
          year: s.firstAirYear, path: s.rootFolderPath || "", monitored: s.monitored,
          qualityProfileId: s.qualityProfileId, status: s.status, overview: s.overview, added: s.addedAt,
          seasons: seasonsRows.filter((x) => x.seriesId === s.id).map((x) => ({ seasonNumber: x.seasonNumber, monitored: x.monitored })),
        } satisfies CompatSeries));
      },
      getSeries: async (id) => {
        const rows = await this.series.list({});
        const s = rows.items.find((x) => x.id === id);
        if (!s) return null;
        return {
          id: s.id, title: s.title, tvdbId: s.tvdbId, seriesType: s.seriesType || "standard",
          year: s.firstAirYear, path: s.rootFolderPath || "", monitored: s.monitored,
          qualityProfileId: s.qualityProfileId, status: s.status, overview: s.overview, added: s.addedAt,
        } satisfies CompatSeries;
      },
      addSeries: async (input) => {
        const created = await this.series.create({
          title: String(input.title ?? ""),
          tvdbId: input.tvdbId ? Number(input.tvdbId) : undefined,
          rootFolderPath: String(input.rootFolderPath ?? ""),
          monitored: input.monitored === undefined ? true : Boolean(input.monitored),
          seriesType: (String(input.seriesType ?? "standard")) as "standard" | "daily" | "anime",
          qualityProfileId: input.qualityProfileId ? String(input.qualityProfileId) : undefined,
          overview: "",
          tags: [],
        });
        return {
          id: created.id, title: created.title, tvdbId: created.tvdbId, seriesType: created.seriesType || "standard",
          year: created.firstAirYear, path: created.rootFolderPath, monitored: created.monitored,
          qualityProfileId: created.qualityProfileId, status: created.status,
        };
      },
      removeSeries: async (id) => { await this.series.remove(id); },
      qualityProfiles: async () => {
        const rows = await this.db.select().from(schema.qualityProfile);
        return rows.map(toCompatQualityProfile);
      },
      episodes: async (sid, season) => {
        const rows = await this.series.episodes(sid, season);
        return rows.map((r) => ({
          id: r.episode.id, seriesId: r.episode.seriesId, seasonNumber: r.seasonNumber,
          episodeNumber: r.episode.episodeNumber, title: r.episode.title, monitored: r.episode.monitored,
          hasFile: r.episode.hasFile, airDateUtc: r.episode.airDateUtc,
        } satisfies CompatEpisode));
      },
      runCommand: async (name, _body) => {
        if (name === "SeriesSearch" || name === "MissingEpisodeSearch") await this.jobs.dispatch({ jobKey: "media.missingSearch", trigger: "manual" });
        else if (name === "RefreshSeries" || name === "RssSync") await this.jobs.dispatch({ jobKey: "discovery.indexerRefresh", trigger: "manual" });
        return { id: `cmd_${Date.now()}`, name };
      },
    };
  }

  // ---------- Radarr v3 ----------
  private radarrSource(): RadarrNativeSource {
    const app = this.app();
    return {
      appVersion: () => app.version, appName: () => app.name, started: () => app.started, databaseVersion: () => app.db,
      listMovies: async () => (await this.movies.list({})).items.map((m): CompatMovie => ({
        id: m.id, title: m.title, tmdbId: m.tmdbId, status: m.status, year: m.releaseDate ? Number(m.releaseDate.slice(0, 4)) : null,
        path: m.rootFolderPath || "", monitored: m.monitored, qualityProfileId: m.qualityProfileId, overview: m.overview, added: m.addedAt, hasFile: m.hasFile,
      })),
      getMovie: async (id) => {
        try { const m = await this.movies.get(id); return { id: m.id, title: m.title, tmdbId: m.tmdbId, status: m.status, year: m.releaseDate ? Number(m.releaseDate.slice(0, 4)) : null, path: m.rootFolderPath, monitored: m.monitored, qualityProfileId: m.qualityProfileId, overview: m.overview, added: m.addedAt, hasFile: m.hasFile }; }
        catch { return null; }
      },
      addMovie: async (input) => {
        const created = await this.movies.create({
          title: String(input.title ?? ""),
          tmdbId: input.tmdbId ? Number(input.tmdbId) : undefined,
          rootFolderPath: String(input.rootFolderPath ?? ""),
          monitored: input.monitored === undefined ? true : Boolean(input.monitored),
          overview: "",
          tags: [],
          // Radarr's AddMovieOptions has a minimumAvailability field with different enum
          // casing than ours ("inCinemas" vs "in_cinemas", etc.) — mapping it is real work
          // this compat write surface doesn't otherwise attempt (see the hardcoded overview/
          // tags above), so default like every other omitted field here does.
          minimumAvailability: "announced",
        });
        return { id: created.id, title: created.title, tmdbId: created.tmdbId, status: created.status, year: created.releaseDate ? Number(created.releaseDate.slice(0, 4)) : null, path: created.rootFolderPath, monitored: created.monitored, qualityProfileId: created.qualityProfileId, hasFile: false } satisfies CompatMovie;
      },
      removeMovie: async (id) => { await this.movies.remove(id); },
      qualityProfiles: async () => (await this.db.select().from(schema.qualityProfile)).map(toCompatQualityProfile),
      runCommand: async (name, _body) => {
        if (name === "MoviesSearch" || name.startsWith("MovieSearch")) await this.jobs.dispatch({ jobKey: "media.missingSearch", trigger: "manual" });
        else if (name === "RefreshMovie") await this.jobs.dispatch({ jobKey: "discovery.indexerRefresh", trigger: "manual" });
        return { id: `cmd_${Date.now()}`, name };
      },
    };
  }

  // ---------- Prowlarr v1 ----------
  private prowlarrSource(): ProwlarrNativeSource {
    const app = this.app();
    return {
      appVersion: () => app.version, appName: () => app.name, started: () => app.started, databaseVersion: () => app.db,
      listIndexers: async () => {
        const rows = await this.db.select().from(schema.indexer).orderBy(desc(schema.indexer.priority));
        const defNames = await this.db.select().from(schema.indexerDefinition);
        return rows.map((r): CompatIndexerDef => {
          const def = defNames.find((d) => d.key === r.definitionKey);
          // J9: redact credential fields before exposing to a Prowlarr-ecosystem client —
          // previously leaked plaintext API keys/passwords, and would now leak ciphertext.
          const settings = redactSettings((r.settings ?? {}) as Record<string, unknown>) ?? {};
          return {
            id: r.id,
            name: r.name,
            fields: Object.entries(settings).map(([name, value]) => ({ name, value })),
            implementation: r.implementation,
            protocol: r.protocol,
            tags: [],
            definitionName: def?.name ?? r.name,
            configContract: r.implementation,
          };
        });
      },
      search: async (query, _categories) => {
        const res = await this.indexers.search({ mediaType: "movie", mediaId: "0", query, limit: 50 });
        return res.releases.map((r): CompatSearchResult => ({
          guid: r.id, title: r.title, size: r.size, seeders: r.seeders, peers: r.peers, indexer: r.indexerName,
          indexerId: r.indexerId, categories: r.categories, magnetUrl: r.magnetUrl, downloadUrl: r.downloadUrl,
          infoUrl: r.infoUrl, protocol: r.protocol, publishDate: new Date().toISOString(),
        }));
      },
    };
  }


  /** Express handler for a registered surface (used by configure.ts). */
  handleFor(surface: CompatSurface) {
    return (req: Request, res: Response, next: NextFunction): Promise<void> | void => {
      const path = `${req.baseUrl}${req.path}`;
      const hit = surface.match(req.method as never, path);
      if (!hit) {
        res.status(404).json({ message: `No compatible route for ${req.method} ${path}` });
        return;
      }
      hit.ctx.query = req.query as never;
      hit.ctx.headers = req.headers as never;
      hit.ctx.body = req.body;
      hit.ctx.apiKey = req.headers["x-api-key"] as string | undefined;
      hit.route.handler(hit.ctx)
        .then((result) => { res.status(result.status).json(result.body); })
        .catch(next);
    };
  }
}
