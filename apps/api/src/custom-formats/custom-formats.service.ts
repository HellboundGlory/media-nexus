// SPDX-License-Identifier: MIT
import { Inject, Injectable } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import { newEntityId, ApiError } from "@medianexus/shared";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import type { CustomFormatBody, UpdateCustomFormatBody } from "@medianexus/domain";

/**
 * Native CRUD for custom formats (roadmap P2, gap report B4/D6). A custom format is a
 * named collection of release-matching specs (term/regex, size, language, indexer) whose
 * shape is validated against packages/domain/src/custom-formats.ts. Quality profiles
 * reference formats by id through quality_profile.format_scores; deleting a format here
 * can orphan a score-map key but never crashes a decision (absent keys score 0).
 */
@Injectable()
export class CustomFormatsService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  list() {
    return this.db.select().from(schema.customFormat).orderBy(asc(schema.customFormat.name));
  }

  async get(id: string) {
    const rows = await this.db.select().from(schema.customFormat).where(eq(schema.customFormat.id, id)).limit(1);
    if (!rows[0]) throw ApiError.notFound("custom format", id);
    return rows[0];
  }

  async create(input: CustomFormatBody) {
    const dup = await this.db.select().from(schema.customFormat).where(eq(schema.customFormat.name, input.name)).limit(1);
    if (dup[0]) throw new ApiError({ code: "CONFLICT", message: `Custom format "${input.name}" already exists` });

    const now = new Date().toISOString();
    const row = { id: newEntityId("cf"), name: input.name, specs: input.specs, createdAt: now, updatedAt: now };
    await this.db.insert(schema.customFormat).values(row);
    return row;
  }

  async update(id: string, input: UpdateCustomFormatBody) {
    const existing = await this.get(id);
    if (input.name && input.name !== existing.name) {
      const dup = await this.db.select().from(schema.customFormat).where(eq(schema.customFormat.name, input.name)).limit(1);
      if (dup[0]) throw new ApiError({ code: "CONFLICT", message: `Custom format "${input.name}" already exists` });
    }
    const merged = {
      name: input.name ?? existing.name,
      specs: input.specs ?? existing.specs,
    };
    const updatedAt = new Date().toISOString();
    await this.db.update(schema.customFormat).set({ ...merged, updatedAt }).where(eq(schema.customFormat.id, id));
    return { ...existing, ...merged, updatedAt };
  }

  async remove(id: string) {
    await this.get(id);
    // Score-map entries in quality_profile.format_scores keyed by this id are left in
    // place (harmless — absent keys score 0); stripping them is a profile concern, not a
    // format-catalog concern, and matches the tags module's write-least behaviour.
    await this.db.delete(schema.customFormat).where(eq(schema.customFormat.id, id));
    return { removed: id };
  }
}
