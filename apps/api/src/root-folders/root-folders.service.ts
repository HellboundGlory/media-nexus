// SPDX-License-Identifier: MIT
import { Inject, Injectable } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { newEntityId, ApiError } from "@medianexus/shared";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import { LocalStorageProvider } from "@medianexus/integrations";
import type { CreateRootFolder, UpdateRootFolderBody } from "@medianexus/domain";
import { resolvedMovieFolderName, resolvedSeriesFolderName } from "../media/naming.helpers";
import { ConfigService } from "../system/config.service";

type RootFolderRow = typeof schema.rootFolder.$inferSelect;

export interface RootFolderView extends RootFolderRow {
  accessible: boolean;
  freeBytes: number | null;
  totalBytes: number | null;
}

/** One top-level folder in a root folder that isn't already mapped to an added title
 *  (gap report B3, Library Import). `suggestedMediaType`/`suggestedTitle`/`suggestedYear` are
 *  pre-fill hints only — never authoritative; the user confirms/overrides at add time. */
export interface UnmappedFolder {
  name: string;
  path: string;
  suggestedTitle: string | null;
  suggestedYear: number | null;
  suggestedMediaType?: "movie" | "series";
}

export interface UnmappedFolders {
  path: string;
  items: UnmappedFolder[];
}

// Sonarr's own special-folder exclusion list (matched case-insensitively): these are not
// titles, and a recycle bin named after one of them lives inside a root folder. Match
// upstream rather than inventing our own shorter list.
const SONARR_SPECIAL_FOLDERS = new Set([
  "$recycle.bin", "system volume information", "recycler", "lost+found",
  ".appledb", ".appledesktop", ".appledouble", "@eadir", ".grab",
]);

/** Best-effort (title, year) from an on-disk folder name, for pre-filling the TMDB search.
 *  Movie folders conventionally end "Title (YYYY)"; anything else is treated as a plain title
 *  (dots/underscores read as spaces, matching how unmapped scene-style folders typically
 *  differ from the movieFolderName() "Title (YYYY)" convention we'd compute for the added row). */
function folderHint(name: string): { suggestedTitle: string | null; suggestedYear: number | null } {
  const m = /^(.*?)\s*\((\d{4})\)\s*$/.exec(name);
  let title = name;
  let suggestedYear: number | null = null;
  if (m) {
    title = m[1];
    suggestedYear = Number(m[2]);
  }
  const suggestedTitle = title.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
  return { suggestedTitle: suggestedTitle || null, suggestedYear };
}

/**
 * Root folders (roadmap P1, gap report B8): promotes the single-array `paths.rootFolders`
 * setting to a real, per-title-assignable entity, with live accessibility and free-space
 * probing — `LocalStorageProvider.diskFree()` existed but was called by nothing before
 * this. Movies/series still store their assigned path as free text on the row itself
 * (`rootFolderPath`, unchanged) rather than a foreign key — matching upstream, where a
 * title's path is fixed at add time and editing it is a separate move operation (not yet
 * built here; see gap report C5). This service is the source of the *choices* offered at
 * add time and the default fallback `AcquisitionService.resolveRoot()` and
 * `DecisionService` use when a title has none set.
 */
@Injectable()
export class RootFoldersService {
  private readonly storage = new LocalStorageProvider();

  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly config: ConfigService,
  ) {}

  async list(): Promise<RootFolderView[]> {
    const rows = await this.db.select().from(schema.rootFolder).orderBy(asc(schema.rootFolder.createdAt));
    return Promise.all(rows.map((r) => this.withProbe(r)));
  }

  async get(id: string): Promise<RootFolderView> {
    const rows = await this.db.select().from(schema.rootFolder).where(eq(schema.rootFolder.id, id)).limit(1);
    if (!rows[0]) throw ApiError.notFound("root folder", id);
    return this.withProbe(rows[0]);
  }

  /** The row `resolveRoot()`/`DecisionService` fall back to when a title has no root
   *  folder of its own: the explicit default for that media type, or the oldest configured
   *  row, or null. Per-media-type default (ROOTFOLDER-1) — a root folder can be the default
   *  for movies, for series, both, or neither, decided independently. */
  async getDefault(mediaType: "movie" | "series"): Promise<RootFolderRow | null> {
    const rows = await this.db.select().from(schema.rootFolder).orderBy(asc(schema.rootFolder.createdAt));
    if (mediaType === "movie") return rows.find((r) => r.isDefaultMovie) ?? rows[0] ?? null;
    return rows.find((r) => r.isDefaultSeries) ?? rows[0] ?? null;
  }

  /** Library Import browse (gap report B3): list the top-level folder entries of a root
   *  folder that aren't already mapped to an added title, with best-effort search pre-fill
   *  hints. Mirrors Sonarr/Radarr's GetUnmappedFolders (which lives in their root-folders
   *  service) — this is a read-only enumeration; adding a picked title is the normal
   *  POST /movies or POST /series flow with rootFolderPath + folderName. */
  async unmapped(rootId: string): Promise<UnmappedFolders> {
    const root = await this.get(rootId);
    // Recycle bin and download dirs are independently configured and not always outside a
    // root folder — exclude them by absolute path (in addition to the name-based special list
    // above), so a nested recycle bin is never offered as a fake "unmapped title".
    const cfg = await this.config.get();
    const exclusions = [cfg["media.recycleBinPath"], cfg["paths.downloads"]]
      .filter((p) => p && p.length > 0)
      .map((p) => resolve(p));

    // A top-level folder is "mapped" when any added title at this root resolves to it
    // (respecting each title's stored folder-name override). Compare on the normalized root
    // path — titles store the exact selected string, which can differ by a trailing slash.
    const normRoot = root.path.replace(/\/+$/, "");
    const mapped = new Set<string>();
    const movieRows = await this.db.select({
      title: schema.movie.title, releaseDate: schema.movie.releaseDate,
      folderName: schema.movie.folderName, rootFolderPath: schema.movie.rootFolderPath,
    }).from(schema.movie);
    for (const m of movieRows) {
      if ((m.rootFolderPath ?? "").replace(/\/+$/, "") === normRoot) mapped.add(resolvedMovieFolderName(m));
    }
    const seriesRows = await this.db.select({
      title: schema.series.title, folderName: schema.series.folderName,
      rootFolderPath: schema.series.rootFolderPath,
    }).from(schema.series);
    for (const s of seriesRows) {
      if ((s.rootFolderPath ?? "").replace(/\/+$/, "") === normRoot) mapped.add(resolvedSeriesFolderName(s));
    }

    const items: UnmappedFolder[] = [];
    for (const entry of await this.storage.list(root.path)) {
      if (!entry.isDirectory) continue;
      const name = basename(entry.path);
      if (!name) continue;
      if (SONARR_SPECIAL_FOLDERS.has(name.toLowerCase())) continue;
      const abs = resolve(root.path, name);
      if (exclusions.some((ex) => ex === abs)) continue;
      if (mapped.has(name)) continue;
      const { suggestedTitle, suggestedYear } = folderHint(name);
      const suggestedMediaType = await this.peekSeasonType(abs);
      items.push({
        name, path: abs, suggestedTitle, suggestedYear,
        ...(suggestedMediaType ? { suggestedMediaType } : {}),
      });
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    return { path: root.path, items };
  }

  /** One-level-deep peek for a "Season N"-style subdirectory, the series folder convention
   *  library-scan recognizes — used only to pre-select the type picker in Library Import, not
   *  authoritative. Errors (permissions, symlink loops) are swallowed and the hint omitted for
   *  that candidate only, never to fail or slow the listing. */
  private async peekSeasonType(dirAbs: string): Promise<"movie" | "series" | undefined> {
    try {
      const entries = await this.storage.list(dirAbs);
      return entries.some((e) => e.isDirectory && /^season\s*\d+$/i.test(basename(e.path)))
        ? "series"
        : undefined;
    } catch {
      return undefined;
    }
  }

  async create(input: CreateRootFolder): Promise<RootFolderRow> {
    // Path existence/type check (roadmap P1, gap report B8): a path that exists but is NOT a
    // directory fails regardless of createIfMissing — you can't mkdir over a file. A path that
    // simply doesn't exist yet either fails with a structured `path_missing` reason (so the UI
    // can offer a create-if-missing confirmation) or, when the user opted in, is created here.
    const exists = existsSync(input.path);
    if (exists && !statSync(input.path).isDirectory()) {
      throw new ApiError({ code: "VALIDATION_ERROR", message: `"${input.path}" is not a directory` });
    }
    if (!exists) {
      if (!input.createIfMissing) {
        throw new ApiError({
          code: "VALIDATION_ERROR",
          message: `"${input.path}" does not exist`,
          details: { reason: "path_missing" },
        });
      }
      mkdirSync(input.path, { recursive: true });
    }
    const dup = await this.db.select().from(schema.rootFolder).where(eq(schema.rootFolder.path, input.path)).limit(1);
    if (dup[0]) throw new ApiError({ code: "CONFLICT", message: `Root folder "${input.path}" already exists` });

    const existing = await this.db.select({ id: schema.rootFolder.id }).from(schema.rootFolder).limit(1);
    // First root folder is the default for BOTH types (nothing else to choose from yet);
    // every later folder only becomes a default when explicitly set per type by the user.
    const isFirst = existing.length === 0;
    const makeMovieDefault = input.isDefaultMovie || isFirst;
    const makeSeriesDefault = input.isDefaultSeries || isFirst;
    const now = new Date().toISOString();
    const row: RootFolderRow = {
      id: newEntityId("rf"),
      path: input.path,
      name: input.name || input.path,
      isDefaultMovie: makeMovieDefault,
      isDefaultSeries: makeSeriesDefault,
      createdAt: now,
    };
    if (this.db.dbDialect === "postgres") {
      // better-sqlite3's native tx wrapper needs a sync callback; node-postgres needs async
      // (P2 item 12 Stage 2) — two irreconcilable signatures, so Postgres gets its own body.
      await this.db.transaction(async (tx) => {
        if (makeMovieDefault) await tx.update(schema.rootFolder).set({ isDefaultMovie: false });
        if (makeSeriesDefault) await tx.update(schema.rootFolder).set({ isDefaultSeries: false });
        await tx.insert(schema.rootFolder).values(row);
      });
    } else {
      this.db.transaction((tx) => {
        if (makeMovieDefault) tx.update(schema.rootFolder).set({ isDefaultMovie: false }).run();
        if (makeSeriesDefault) tx.update(schema.rootFolder).set({ isDefaultSeries: false }).run();
        tx.insert(schema.rootFolder).values(row).run();
      });
    }
    return row;
  }

  async remove(id: string): Promise<{ removed: string }> {
    const row = await this.get(id);
    const inUse = await this.referencedBy(row.path);
    if (inUse) throw new ApiError({ code: "CONFLICT", message: `Root folder is in use by ${inUse}` });

    if (this.db.dbDialect === "postgres") {
      // better-sqlite3's native tx wrapper needs a sync callback; node-postgres needs async
      // (P2 item 12 Stage 2) — two irreconcilable signatures, so Postgres gets its own body.
      await this.db.transaction(async (tx) => {
        await tx.delete(schema.rootFolder).where(eq(schema.rootFolder.id, id));
        // When the removed row was the default for a type, promote the next-oldest to keep the
        // stored flag accurate (so the UI reflects a real default without relying on the
        // getDefault() "oldest row" fallback). Independent per media type.
        const next = (await tx.select().from(schema.rootFolder).orderBy(asc(schema.rootFolder.createdAt)).limit(1))[0];
        if (row.isDefaultMovie && next) await tx.update(schema.rootFolder).set({ isDefaultMovie: true }).where(eq(schema.rootFolder.id, next.id));
        if (row.isDefaultSeries && next) await tx.update(schema.rootFolder).set({ isDefaultSeries: true }).where(eq(schema.rootFolder.id, next.id));
      });
    } else {
      this.db.transaction((tx) => {
        tx.delete(schema.rootFolder).where(eq(schema.rootFolder.id, id)).run();
        if (row.isDefaultMovie) {
          const next = tx.select().from(schema.rootFolder).orderBy(asc(schema.rootFolder.createdAt)).all()[0];
          if (next) tx.update(schema.rootFolder).set({ isDefaultMovie: true }).where(eq(schema.rootFolder.id, next.id)).run();
        }
        if (row.isDefaultSeries) {
          const next = tx.select().from(schema.rootFolder).orderBy(asc(schema.rootFolder.createdAt)).all()[0];
          if (next) tx.update(schema.rootFolder).set({ isDefaultSeries: true }).where(eq(schema.rootFolder.id, next.id)).run();
        }
      });
    }
    return { removed: id };
  }

  /** Edit a root folder (roadmap P1, gap report C5): rename and/or change the default flags.
   *  Each per-type default flag setting `true` makes this the default for THAT type only,
   *  clearing the same type's flag on other rows — but never touching the other type's default
   *  on any row (ROOTFOLDER-1, per-type invariant). Returns the updated row, re-probed. */
  async update(id: string, input: UpdateRootFolderBody): Promise<RootFolderView> {
    const existing = await this.get(id);
    const name = input.name !== undefined ? (input.name || existing.path) : existing.name;
    const isDefaultMovie = input.isDefaultMovie !== undefined ? input.isDefaultMovie : existing.isDefaultMovie;
    const isDefaultSeries = input.isDefaultSeries !== undefined ? input.isDefaultSeries : existing.isDefaultSeries;
    if (this.db.dbDialect === "postgres") {
      // better-sqlite3's native tx wrapper needs a sync callback; node-postgres needs async
      // (P2 item 12 Stage 2) — two irreconcilable signatures, so Postgres gets its own body.
      await this.db.transaction(async (tx) => {
        if (isDefaultMovie && !existing.isDefaultMovie) {
          await tx.update(schema.rootFolder).set({ isDefaultMovie: false }); // movie-default invariant
        }
        if (isDefaultSeries && !existing.isDefaultSeries) {
          await tx.update(schema.rootFolder).set({ isDefaultSeries: false }); // series-default invariant
        }
        await tx.update(schema.rootFolder).set({ name, isDefaultMovie, isDefaultSeries }).where(eq(schema.rootFolder.id, id));
      });
    } else {
      this.db.transaction((tx) => {
        if (isDefaultMovie && !existing.isDefaultMovie) {
          tx.update(schema.rootFolder).set({ isDefaultMovie: false }).run(); // movie-default invariant
        }
        if (isDefaultSeries && !existing.isDefaultSeries) {
          tx.update(schema.rootFolder).set({ isDefaultSeries: false }).run(); // series-default invariant
        }
        tx.update(schema.rootFolder).set({ name, isDefaultMovie, isDefaultSeries }).where(eq(schema.rootFolder.id, id)).run();
      });
    }
    return this.get(id);
  }

  private async referencedBy(path: string): Promise<string | null> {
    const movie = await this.db.select({ id: schema.movie.id }).from(schema.movie).where(eq(schema.movie.rootFolderPath, path)).limit(1);
    if (movie[0]) return "a movie";
    const series = await this.db.select({ id: schema.series.id }).from(schema.series).where(eq(schema.series.rootFolderPath, path)).limit(1);
    if (series[0]) return "a series";
    return null;
  }

  private async withProbe(row: RootFolderRow): Promise<RootFolderView> {
    const { free, total } = await this.storage.diskFree(row.path);
    const accessible = existsSync(row.path) && free >= 0;
    return { ...row, accessible, freeBytes: free >= 0 ? free : null, totalBytes: total >= 0 ? total : null };
  }
}
