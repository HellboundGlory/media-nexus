// SPDX-License-Identifier: MIT
import { Inject, Injectable } from "@nestjs/common";
import { DEFAULT_SETTINGS, runtimeSettingsSchema, type RuntimeSettings } from "@medianexus/shared";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import { decryptRuntimeSettings, encryptRuntimeSettings, getProviderSecret } from "../secrets/provider-secrets";

@Injectable()
export class ConfigService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  /** Merge DB rows over defaults (DB wins). Credential fields are decrypted before
   *  returning so every consumer (notifications, media servers, metadata) sees plaintext
   *  exactly as before — encryption is at-rest only. Tolerant: already-plaintext values
   *  pass through. Must decrypt BEFORE `runtimeSettingsSchema.parse`, because encrypted
   *  values (e.g. a discord webhookUrl) are not valid URLs and would fail parse. */
  async get(): Promise<RuntimeSettings> {
    const rows = await this.db.select().from(schema.setting);
    const stored: Record<string, unknown> = {};
    for (const r of rows) stored[r.key] = r.value;
    const merged = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (key in stored) (merged as Record<string, unknown>)[key] = stored[key];
    }
    const secret = getProviderSecret();
    return runtimeSettingsSchema.parse(decryptRuntimeSettings(merged, secret));
  }

  async upsert(patch: Partial<RuntimeSettings>): Promise<RuntimeSettings> {
    const current = await this.get();
    const merged = { ...current, ...patch };
    const validated = runtimeSettingsSchema.parse(merged);
    // J9: encrypt credential fields before persisting — the `setting` table stores them
    // encrypted at rest; `get()` decrypts them back out. Written for every key (matching
    // the existing loop), re-encrypting is idempotent via `encryptSecretValue`.
    const stored = encryptRuntimeSettings(validated, getProviderSecret());
    const now = new Date().toISOString();
    for (const [k, v] of Object.entries(stored)) {
      await this.db
        .insert(schema.setting)
        .values({ key: k, value: v, updatedAt: now })
        .onConflictDoUpdate({ target: schema.setting.key, set: { value: v, updatedAt: now } });
    }
    return validated;
  }
}
