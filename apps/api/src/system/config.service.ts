// SPDX-License-Identifier: MIT
import { Inject, Injectable } from "@nestjs/common";
import { DEFAULT_SETTINGS, runtimeSettingsSchema, type RuntimeSettings } from "@medianexus/shared";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";

@Injectable()
export class ConfigService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  /** Merge DB rows over defaults (DB wins). */
  async get(): Promise<RuntimeSettings> {
    const rows = await this.db.select().from(schema.setting);
    const stored: Record<string, unknown> = {};
    for (const r of rows) stored[r.key] = r.value;
    const merged = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (key in stored) (merged as Record<string, unknown>)[key] = stored[key];
    }
    return runtimeSettingsSchema.parse(merged);
  }

  async upsert(patch: Partial<RuntimeSettings>): Promise<RuntimeSettings> {
    const current = await this.get();
    const merged = { ...current, ...patch };
    const validated = runtimeSettingsSchema.parse(merged);
    const now = new Date().toISOString();
    for (const [k, v] of Object.entries(validated)) {
      await this.db
        .insert(schema.setting)
        .values({ key: k, value: v, updatedAt: now })
        .onConflictDoUpdate({ target: schema.setting.key, set: { value: v, updatedAt: now } });
    }
    return validated;
  }
}
