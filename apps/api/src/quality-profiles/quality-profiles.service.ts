// SPDX-License-Identifier: MIT
import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { newEntityId, ApiError } from "@medianexus/shared";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import {
  QUALITY_REGISTRY, type QualityProfileBody, type UpdateQualityProfileBody,
} from "@medianexus/domain";

/**
 * Native CRUD for quality profiles (roadmap P0.2). Profiles didn't have an
 * endpoint at all before this — they could only be seeded or created by the
 * upstream importer. See packages/domain/src/quality.ts for the registry and
 * the ordering/cutoff semantics this validates against.
 */
@Injectable()
export class QualityProfilesService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async list() {
    return this.db.select().from(schema.qualityProfile);
  }

  async get(id: string) {
    const rows = await this.db.select().from(schema.qualityProfile).where(eq(schema.qualityProfile.id, id)).limit(1);
    if (!rows[0]) throw ApiError.notFound("quality profile", id);
    return rows[0];
  }

  async create(input: QualityProfileBody) {
    const dup = await this.db.select().from(schema.qualityProfile).where(eq(schema.qualityProfile.name, input.name)).limit(1);
    if (dup[0]) throw new ApiError({ code: "CONFLICT", message: `Quality profile "${input.name}" already exists` });

    const now = new Date().toISOString();
    const id = newEntityId("qp");
    const row = {
      id,
      name: input.name,
      items: input.items,
      cutoffQualityId: input.cutoffQualityId,
      upgradeAllowed: input.upgradeAllowed,
      language: input.language,
      isDefault: input.isDefault,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(schema.qualityProfile).values(row);
    return row;
  }

  async update(id: string, input: UpdateQualityProfileBody) {
    const existing = await this.get(id);
    if (input.name && input.name !== existing.name) {
      const dup = await this.db.select().from(schema.qualityProfile).where(eq(schema.qualityProfile.name, input.name)).limit(1);
      if (dup[0]) throw new ApiError({ code: "CONFLICT", message: `Quality profile "${input.name}" already exists` });
    }
    const merged = {
      name: input.name ?? existing.name,
      items: input.items ?? existing.items,
      cutoffQualityId: input.cutoffQualityId ?? existing.cutoffQualityId,
      upgradeAllowed: input.upgradeAllowed ?? existing.upgradeAllowed,
      language: input.language ?? existing.language,
      isDefault: input.isDefault ?? existing.isDefault,
    };
    if (!merged.items.includes(merged.cutoffQualityId)) {
      throw new ApiError({ code: "VALIDATION_ERROR", message: "cutoffQualityId must be one of items" });
    }
    const updatedAt = new Date().toISOString();
    await this.db.update(schema.qualityProfile).set({ ...merged, updatedAt }).where(eq(schema.qualityProfile.id, id));
    return { ...existing, ...merged, updatedAt };
  }

  async remove(id: string) {
    await this.get(id);
    const inUse = await this.referencedBy(id);
    if (inUse) throw new ApiError({ code: "CONFLICT", message: `Quality profile is in use by ${inUse}` });
    await this.db.delete(schema.qualityProfile).where(eq(schema.qualityProfile.id, id));
    return { removed: id };
  }

  private async referencedBy(id: string): Promise<string | null> {
    const movie = await this.db.select({ id: schema.movie.id }).from(schema.movie).where(eq(schema.movie.qualityProfileId, id)).limit(1);
    if (movie[0]) return "a movie";
    const series = await this.db.select({ id: schema.series.id }).from(schema.series).where(eq(schema.series.qualityProfileId, id)).limit(1);
    if (series[0]) return "a series";
    return null;
  }

  /** Read-only: the registry's per-quality size definitions (min/max/preferred). */
  async definitions() {
    return this.db.select().from(schema.qualityDefinition).orderBy(schema.qualityDefinition.id);
  }

  /** The static ordered registry itself (ids, titles, source/resolution) — not
   *  DB-backed, used by the UI to render the "allowed qualities" picker. */
  registry() {
    return QUALITY_REGISTRY;
  }
}
