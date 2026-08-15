// SPDX-License-Identifier: MIT
import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq } from "drizzle-orm";
import { ApiError, newEntityId } from "@medianexus/shared";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import { MetadataService } from "../metadata/metadata.service";
import { TmdbImportListProvider, type ImportListContract } from "@medianexus/integrations";
import type { CreateImportList, CreateImportExclusion, UpdateImportList } from "@medianexus/domain";

/**
 * Import lists (roadmap P2, gap report C2): a generic watchlist-sync subsystem.
 *
 * An `import_list` row is a configured list source (first pass: TMDB user lists, keyed by
 * a `listId` in `config`). The recurring `media.importLists` job (`runAll`) pulls each
 * enabled list, and every item that isn't already in the library and isn't in the
 * `import_exclusion` "don't re-add" set is added via MetadataService.addFromDiscover()
 * (which creates it `monitored: true` with a default root folder and enriches it from
 * TMDB). A title is excluded automatically when the user removes it from the library, so
 * the next sync doesn't silently re-import it; an exclusion can be cleared to re-add.
 */
@Injectable()
export class ImportListsService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly metadata: MetadataService,
  ) {}

  // ---------- list CRUD ----------
  async list() {
    return await this.db.select().from(schema.importList).orderBy(asc(schema.importList.name));
  }

  async create(input: CreateImportList) {
    const now = new Date().toISOString();
    const row = {
      id: newEntityId("ilist"), provider: input.provider, name: input.name,
      enabled: input.enabled ?? true, config: input.config, createdAt: now, updatedAt: now,
    };
    await this.db.insert(schema.importList).values(row);
    return row;
  }

  async update(id: string, input: UpdateImportList) {
    const rows = await this.db.select().from(schema.importList).where(eq(schema.importList.id, id)).limit(1);
    if (!rows[0]) throw ApiError.notFound("import list", id);
    const merged = {
      name: input.name ?? rows[0].name,
      enabled: input.enabled ?? rows[0].enabled,
      config: input.config ?? rows[0].config,
      updatedAt: new Date().toISOString(),
    };
    await this.db.update(schema.importList).set(merged).where(eq(schema.importList.id, id));
    return { ...rows[0], ...merged };
  }

  async remove(id: string) {
    const rows = await this.db.select().from(schema.importList).where(eq(schema.importList.id, id)).limit(1);
    if (!rows[0]) throw ApiError.notFound("import list", id);
    await this.db.delete(schema.importList).where(eq(schema.importList.id, id));
    return { removed: id };
  }

  // ---------- exclusions ----------
  async listExclusions() {
    return await this.db.select().from(schema.importExclusion).orderBy(desc(schema.importExclusion.createdAt));
  }

  async addExclusion(input: CreateImportExclusion) {
    await this.db.insert(schema.importExclusion)
      .values({ id: newEntityId("excl"), mediaType: input.mediaType, externalId: input.externalId, reason: input.reason ?? null, createdAt: new Date().toISOString() })
      .onConflictDoNothing();
    return { added: true, mediaType: input.mediaType, externalId: input.externalId };
  }

  async removeExclusion(id: string) {
    const rows = await this.db.select().from(schema.importExclusion).where(eq(schema.importExclusion.id, id)).limit(1);
    if (!rows[0]) throw ApiError.notFound("exclusion", id);
    await this.db.delete(schema.importExclusion).where(eq(schema.importExclusion.id, id));
    return { removed: id };
  }

  private async isExcluded(mediaType: "movie" | "series", externalId: string): Promise<boolean> {
    const rows = await this.db.select({ id: schema.importExclusion.id }).from(schema.importExclusion)
      .where(and(eq(schema.importExclusion.mediaType, mediaType), eq(schema.importExclusion.externalId, externalId))).limit(1);
    return rows.length > 0;
  }

  // ---------- sync ----------
  async syncList(id: string): Promise<{ added: number; skipped: number }> {
    const rows = await this.db.select().from(schema.importList).where(eq(schema.importList.id, id)).limit(1);
    const list = rows[0];
    if (!list) throw ApiError.notFound("import list", id);
    const provider = await this.buildProvider(list);
    const items = await provider.fetchItems();

    let added = 0;
    let skipped = 0;
    for (const item of items) {
      if (await this.isExcluded(item.mediaType, item.externalId)) { skipped++; continue; }
      // addFromDiscover returns { created: false } when the title is already in the
      // library — that's the "already imported" skip. A per-title failure (e.g. no resolvable
      // TVDB id for a series) is skipped, not fatal to the whole list.
      try {
        const res = await this.metadata.addFromDiscover(item.mediaType, Number(item.externalId));
        if (res.created) added++; else skipped++;
      } catch { skipped++; }
    }

    const now = new Date().toISOString();
    await this.db.update(schema.importList)
      .set({ lastSyncAt: now, lastError: null, updatedAt: now })
      .where(eq(schema.importList.id, id));
    return { added, skipped };
  }

  /** Sync every enabled list (the `media.importLists` job). One bad list can't abort the
   *  rest — each failure is recorded on the list and the loop continues. */
  async runAll(): Promise<{ lists: number; added: number; failed: number }> {
    const lists = await this.db.select().from(schema.importList).where(eq(schema.importList.enabled, true));
    let added = 0;
    let failed = 0;
    const now = new Date().toISOString();
    for (const list of lists) {
      try {
        const r = await this.syncList(list.id);
        added += r.added;
      } catch (err) {
        failed++;
        await this.db.update(schema.importList)
          .set({ lastError: (err as Error).message, lastSyncAt: now, updatedAt: now })
          .where(eq(schema.importList.id, list.id));
      }
    }
    return { lists: lists.length, added, failed };
  }

  private async buildProvider(list: typeof schema.importList.$inferSelect): Promise<ImportListContract> {
    if (list.provider === "tmdb") {
      const tmdb = await this.metadata.provider();
      const listId = String((list.config as { listId?: string | number })?.listId ?? "");
      if (!listId) throw new ApiError({ code: "UNPROCESSABLE", message: `Import list "${list.name}" has no listId configured` });
      return new TmdbImportListProvider(tmdb, listId);
    }
    throw new ApiError({ code: "UNPROCESSABLE", message: `Unsupported import list provider "${list.provider}"` });
  }
}
