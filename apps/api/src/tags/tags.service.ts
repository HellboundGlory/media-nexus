// SPDX-License-Identifier: MIT
import { Inject, Injectable } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import { ApiError } from "@medianexus/shared";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import type { CreateTag, UpdateTag } from "@medianexus/domain";

/** The tag-bearing entity tables whose `tags` arrays reference tag ids (gap report C6):
 *  when a tag is deleted, its id is stripped from each of these so no dangling keys linger. */
const TAG_BEARING_TABLES = [schema.movie, schema.series, schema.indexer, schema.downloadClient] as const;

/** Tag catalog (roadmap P2, gap report C6). A tag is a stable `id` (that entity `tags`
 *  arrays reference) plus a human `label`/`color`. Routing (indexer scoping / download-
 *  client routing) matches purely on the array strings; this module just manages the
 *  catalog and keeps entity arrays consistent on delete. */
@Injectable()
export class TagsService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  list() {
    return this.db.select().from(schema.tag).orderBy(asc(schema.tag.label)).all();
  }

  async create(input: CreateTag) {
    const existing = await this.db.select().from(schema.tag).where(eq(schema.tag.id, input.id)).limit(1);
    if (existing[0]) throw new ApiError({ code: "CONFLICT", message: `Tag "${input.id}" already exists` });
    const now = new Date().toISOString();
    const row = { id: input.id, label: input.label ?? input.id, color: input.color ?? null, createdAt: now, updatedAt: now };
    await this.db.insert(schema.tag).values(row).run();
    return row;
  }

  async update(id: string, input: UpdateTag) {
    const rows = await this.db.select().from(schema.tag).where(eq(schema.tag.id, id)).limit(1);
    if (!rows[0]) throw ApiError.notFound("tag", id);
    const merged = {
      label: input.label ?? rows[0].label,
      color: input.color !== undefined ? input.color : rows[0].color,
      updatedAt: new Date().toISOString(),
    };
    await this.db.update(schema.tag).set(merged).where(eq(schema.tag.id, id)).run();
    return { ...rows[0], ...merged };
  }

  /** Delete a tag and strip its id from every entity that references it, so no dangling
   *  keys remain anywhere. Atomic (one transaction). */
  async remove(id: string): Promise<{ removed: string }> {
    const rows = await this.db.select().from(schema.tag).where(eq(schema.tag.id, id)).limit(1);
    if (!rows[0]) throw ApiError.notFound("tag", id);
    this.db.transaction((tx) => {
      tx.delete(schema.tag).where(eq(schema.tag.id, id)).run();
      for (const table of TAG_BEARING_TABLES) {
        for (const row of tx.select().from(table).all()) {
          const tags = (row as { tags?: string[] | null }).tags ?? [];
          if (tags.includes(id)) {
            tx.update(table).set({ tags: tags.filter((t) => t !== id) })
              .where(eq((table as { id: unknown }).id as never, row.id)).run();
          }
        }
      }
    });
    return { removed: id };
  }
}
