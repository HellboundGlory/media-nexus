// SPDX-License-Identifier: MIT
import { Inject, Injectable } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import { existsSync, statSync } from "node:fs";
import { newEntityId, ApiError } from "@medianexus/shared";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import { LocalStorageProvider } from "@medianexus/integrations";
import type { CreateRootFolder, UpdateRootFolderBody } from "@medianexus/domain";

type RootFolderRow = typeof schema.rootFolder.$inferSelect;

export interface RootFolderView extends RootFolderRow {
  accessible: boolean;
  freeBytes: number | null;
  totalBytes: number | null;
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

  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

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
   *  folder of its own: the explicit default, or the oldest configured row, or null. */
  async getDefault(): Promise<RootFolderRow | null> {
    const rows = await this.db.select().from(schema.rootFolder).orderBy(asc(schema.rootFolder.createdAt));
    return rows.find((r) => r.isDefault) ?? rows[0] ?? null;
  }

  async create(input: CreateRootFolder): Promise<RootFolderRow> {
    if (!existsSync(input.path) || !statSync(input.path).isDirectory()) {
      throw new ApiError({ code: "VALIDATION_ERROR", message: `"${input.path}" is not an accessible directory` });
    }
    const dup = await this.db.select().from(schema.rootFolder).where(eq(schema.rootFolder.path, input.path)).limit(1);
    if (dup[0]) throw new ApiError({ code: "CONFLICT", message: `Root folder "${input.path}" already exists` });

    const existing = await this.db.select({ id: schema.rootFolder.id }).from(schema.rootFolder).limit(1);
    const makeDefault = input.isDefault || existing.length === 0; // first root folder is always the default
    const now = new Date().toISOString();
    const row: RootFolderRow = {
      id: newEntityId("rf"),
      path: input.path,
      name: input.name || input.path,
      isDefault: makeDefault,
      createdAt: now,
    };
    if (this.db.dbDialect === "postgres") {
      // better-sqlite3's native tx wrapper needs a sync callback; node-postgres needs async
      // (P2 item 12 Stage 2) — two irreconcilable signatures, so Postgres gets its own body.
      await this.db.transaction(async (tx) => {
        if (makeDefault) await tx.update(schema.rootFolder).set({ isDefault: false });
        await tx.insert(schema.rootFolder).values(row);
      });
    } else {
      this.db.transaction((tx) => {
        if (makeDefault) tx.update(schema.rootFolder).set({ isDefault: false }).run();
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
        if (row.isDefault) {
          const next = (await tx.select().from(schema.rootFolder).orderBy(asc(schema.rootFolder.createdAt)).limit(1))[0];
          if (next) await tx.update(schema.rootFolder).set({ isDefault: true }).where(eq(schema.rootFolder.id, next.id));
        }
      });
    } else {
      this.db.transaction((tx) => {
        tx.delete(schema.rootFolder).where(eq(schema.rootFolder.id, id)).run();
        if (row.isDefault) {
          const next = tx.select().from(schema.rootFolder).orderBy(asc(schema.rootFolder.createdAt)).all()[0];
          if (next) tx.update(schema.rootFolder).set({ isDefault: true }).where(eq(schema.rootFolder.id, next.id)).run();
        }
      });
    }
    return { removed: id };
  }

  /** Edit a root folder (roadmap P1, gap report C5): rename and/or change the default flag.
   *  Setting `isDefault: true` makes this the single default (clearing others, matching
   *  create()'s invariant). Returns the updated row, re-probed. */
  async update(id: string, input: UpdateRootFolderBody): Promise<RootFolderView> {
    const existing = await this.get(id);
    const name = input.name !== undefined ? (input.name || existing.path) : existing.name;
    const isDefault = input.isDefault !== undefined ? input.isDefault : existing.isDefault;
    if (this.db.dbDialect === "postgres") {
      // better-sqlite3's native tx wrapper needs a sync callback; node-postgres needs async
      // (P2 item 12 Stage 2) — two irreconcilable signatures, so Postgres gets its own body.
      await this.db.transaction(async (tx) => {
        if (isDefault && !existing.isDefault) {
          await tx.update(schema.rootFolder).set({ isDefault: false }); // single-default invariant
        }
        await tx.update(schema.rootFolder).set({ name, isDefault }).where(eq(schema.rootFolder.id, id));
      });
    } else {
      this.db.transaction((tx) => {
        if (isDefault && !existing.isDefault) {
          tx.update(schema.rootFolder).set({ isDefault: false }).run(); // single-default invariant
        }
        tx.update(schema.rootFolder).set({ name, isDefault }).where(eq(schema.rootFolder.id, id)).run();
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
