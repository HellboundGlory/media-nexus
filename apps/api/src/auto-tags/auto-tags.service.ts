// SPDX-License-Identifier: MIT
import { Inject, Injectable } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import { newEntityId, ApiError } from "@medianexus/shared";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import {
  computeTagChanges, type AutoTagBody, type UpdateAutoTagBody, type AutoTagItemInput,
} from "@medianexus/domain";

/**
 * CRUD for auto-tag rules (roadmap P3, gap report C6) + the shared evaluation hook that movies/
 * series services call on create/update and metadata refresh. A rule is a named set of typed
 * specifications (genre, status, network, ...) that auto-applies (and optionally removes) its
 * `tags` on matching media, mirroring upstream AutoTag. Shape validated against
 * packages/domain/src/auto-tag.ts; the matching algorithm lives in the pure domain.
 */
@Injectable()
export class AutoTagsService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  list() {
    return this.db.select().from(schema.autoTag).orderBy(asc(schema.autoTag.name));
  }

  async get(id: string) {
    const rows = await this.db.select().from(schema.autoTag).where(eq(schema.autoTag.id, id)).limit(1);
    if (!rows[0]) throw ApiError.notFound("auto-tag rule", id);
    return rows[0];
  }

  async create(input: AutoTagBody) {
    const dup = await this.db.select().from(schema.autoTag).where(eq(schema.autoTag.name, input.name)).limit(1);
    if (dup[0]) throw new ApiError({ code: "CONFLICT", message: `Auto-tag rule "${input.name}" already exists` });

    const now = new Date().toISOString();
    const row = {
      id: newEntityId("at"),
      name: input.name,
      removeTagsAutomatically: input.removeTagsAutomatically,
      tags: input.tags,
      specifications: input.specifications,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(schema.autoTag).values(row);
    return row;
  }

  async update(id: string, input: UpdateAutoTagBody) {
    const existing = await this.get(id);
    const merged = {
      name: input.name ?? existing.name,
      removeTagsAutomatically: input.removeTagsAutomatically ?? existing.removeTagsAutomatically,
      tags: input.tags ?? existing.tags,
      specifications: input.specifications ?? existing.specifications,
    };
    const updatedAt = new Date().toISOString();
    await this.db.update(schema.autoTag).set({ ...merged, updatedAt }).where(eq(schema.autoTag.id, id));
    return { ...existing, ...merged, updatedAt };
  }

  async remove(id: string) {
    await this.get(id);
    await this.db.delete(schema.autoTag).where(eq(schema.autoTag.id, id));
    return { removed: id };
  }

  /** Evaluate all auto-tag rules against an item snapshot and return its merged tags array
   *  (current minus auto-removed, plus auto-added). Callers thread this into the same create /
   *  update / refresh write so tag changes are one atomic update, not a second write/event. */
  async appliedTags(item: AutoTagItemInput): Promise<string[]> {
    const rules = await this.db.select().from(schema.autoTag);
    const { toAdd, toRemove } = computeTagChanges(rules, item);
    return [...item.tags.filter((t) => !toRemove.includes(t)), ...toAdd];
  }
}
