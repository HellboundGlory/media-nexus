// SPDX-License-Identifier: MIT
import { Inject, Injectable } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import { newEntityId, ApiError } from "@medianexus/shared";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import type { ReleaseProfileBody, UpdateReleaseProfileBody } from "@medianexus/domain";

/**
 * Native CRUD for release profiles (roadmap P3, gap report C6). A release profile is a named,
 * tag-scoped set of hard Required/Ignored term restrictions evaluated by the decision engine's
 * `releaseProfileSpecification` (packages/domain/src/decision.ts). Shape validated against
 * packages/domain/src/release-profile.ts. Reject-only — no scored/"preferred" terms (that's Custom
 * Formats' job), matching current upstream Sonarr.
 */
@Injectable()
export class ReleaseProfilesService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  list() {
    return this.db.select().from(schema.releaseProfile).orderBy(asc(schema.releaseProfile.name));
  }

  async get(id: string) {
    const rows = await this.db.select().from(schema.releaseProfile).where(eq(schema.releaseProfile.id, id)).limit(1);
    if (!rows[0]) throw ApiError.notFound("release profile", id);
    return rows[0];
  }

  async create(input: ReleaseProfileBody) {
    const dup = await this.db.select().from(schema.releaseProfile).where(eq(schema.releaseProfile.name, input.name)).limit(1);
    if (dup[0]) throw new ApiError({ code: "CONFLICT", message: `Release profile "${input.name}" already exists` });

    const now = new Date().toISOString();
    const row = {
      id: newEntityId("rp"),
      name: input.name,
      enabled: input.enabled,
      required: input.required,
      ignored: input.ignored,
      tags: input.tags,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(schema.releaseProfile).values(row);
    return row;
  }

  async update(id: string, input: UpdateReleaseProfileBody) {
    const existing = await this.get(id);
    // `??` merges only fields the caller actually sent; an empty array is a real value (clearing
    // terms), so it survives `??` — only nullish (omitted) keys fall back to the existing value.
    const merged = {
      name: input.name ?? existing.name,
      enabled: input.enabled ?? existing.enabled,
      required: input.required ?? existing.required,
      ignored: input.ignored ?? existing.ignored,
      tags: input.tags ?? existing.tags,
    };
    const updatedAt = new Date().toISOString();
    await this.db.update(schema.releaseProfile).set({ ...merged, updatedAt }).where(eq(schema.releaseProfile.id, id));
    return { ...existing, ...merged, updatedAt };
  }

  async remove(id: string) {
    await this.get(id);
    await this.db.delete(schema.releaseProfile).where(eq(schema.releaseProfile.id, id));
    return { removed: id };
  }
}
