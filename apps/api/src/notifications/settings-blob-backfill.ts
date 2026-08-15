// SPDX-License-Identifier: MIT
/**
 * Roadmap P2 / gap report J4/D7 — settings-blob configs → real entities.
 *
 * Promotes the legacy JSON arrays in the `setting` table — `notifications.webhooks`,
 * `notifications.discord`, `notifications.telegram`, `notifications.email`, and
 * `media.servers` — into real rows in the new `notification` / `media_server` tables,
 * each with a stable id (previously addressed by array index).
 *
 * Why this is a startup data pass and not a Drizzle SQL migration: it needs to run
 * against whatever `schema` the code currently declares (like `secret-backfill.ts`),
 * and it performs a structural remap (array index → entity row) that reads the raw
 * `setting` rows directly off the table, bypassing `ConfigService`/zod — the same
 * shape as `secret-backfill.ts`. It does NOT need the secret (a field's
 * ciphertext-or-plaintext state is carried through unchanged; the new table's own
 * read/write boundary applies the identical codec to the same field either way).
 *
 * Runs exactly once, guarded by a one-time sentinel (`system._settingsBlobMigratedV1`),
 * NOT by "table is empty" — a user who later deletes every configured sink must not have
 * them silently resurrected on next boot. Non-destructive: existing configured sinks
 * survive the upgrade, carried field-for-field (secrets byte-for-byte). After a
 * successful pass it deletes the superseded `setting` rows and sets the sentinel, so it
 * no-ops on repeat boots.
 */
import { eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@medianexus/database";
import { newEntityId } from "@medianexus/shared";

/** Sentinel gate: once set, the backfill never runs again, even if the table empties. */
export const SETTINGS_BLOB_MIGRATED_KEY = "system._settingsBlobMigratedV1";

/** Legacy `setting` keys this pass consumes. */
const NOTIFICATION_SETTING_KEYS = [
  "notifications.webhooks",
  "notifications.discord",
  "notifications.telegram",
  "notifications.email",
] as const;
const MEDIA_SERVER_SETTING_KEY = "media.servers";

const NOTIFICATION_KIND: Record<string, string> = {
  "notifications.webhooks": "webhook",
  "notifications.discord": "discord",
  "notifications.telegram": "telegram",
  "notifications.email": "email",
};

/** The kind-specific `settings` column fields, per kind (mirrors provider-secrets + notify-sinks). */
const NOTIFICATION_SETTING_FIELDS: Record<string, string[]> = {
  webhook: ["url", "secret"],
  discord: ["webhookUrl"],
  telegram: ["botToken", "chatId", "baseUrl"],
  email: ["from", "to", "transport", "subject"],
};

export interface SettingsBlobBackfillResult {
  notifications: number;
  mediaServers: number;
  /** True when the sentinel was already set, so nothing ran this boot. */
  skipped: boolean;
}

export async function runSettingsBlobBackfill(db: Db): Promise<SettingsBlobBackfillResult> {
  const sentinelRows = await db.select().from(schema.setting).where(eq(schema.setting.key, SETTINGS_BLOB_MIGRATED_KEY));
  if (sentinelRows.length) {
    return { notifications: 0, mediaServers: 0, skipped: true };
  }

  const result: SettingsBlobBackfillResult = { notifications: 0, mediaServers: 0, skipped: false };
  const now = new Date().toISOString();

  // Read the raw rows directly off `schema.setting` (bypassing ConfigService/zod
  // validation, matching `secret-backfill.ts`). `inArray` with a possibly-empty target
  // would generate `IN ()` — guard by only querying when there are keys.
  const keys = [...NOTIFICATION_SETTING_KEYS, MEDIA_SERVER_SETTING_KEY];
  const rows = await db.select().from(schema.setting).where(inArray(schema.setting.key, keys));
  const byKey = new Map(rows.map((r) => [r.key, r.value]));

  // --- notifications ---
  for (const key of NOTIFICATION_SETTING_KEYS) {
    const kind = NOTIFICATION_KIND[key];
    const entries = (Array.isArray(byKey.get(key)) ? byKey.get(key) : []) as Record<string, unknown>[];
    const fields = NOTIFICATION_SETTING_FIELDS[kind];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i] ?? {};
      const settings: Record<string, unknown> = {};
      for (const f of fields) if (entry[f] !== undefined) settings[f] = entry[f];
      await db.insert(schema.notification).values({
        id: newEntityId("notif"),
        kind,
        name: typeof entry.name === "string" && entry.name ? entry.name : `${kind} ${i + 1}`,
        enabled: typeof entry.enabled === "boolean" ? entry.enabled : true,
        eventTypes: Array.isArray(entry.eventTypes) ? (entry.eventTypes as string[]) : [],
        settings,
        createdAt: now,
        updatedAt: now,
      });
      result.notifications++;
    }
  }

  // --- media servers ---
  const servers = (Array.isArray(byKey.get(MEDIA_SERVER_SETTING_KEY)) ? byKey.get(MEDIA_SERVER_SETTING_KEY) : []) as Record<string, unknown>[];
  for (let i = 0; i < servers.length; i++) {
    const entry = servers[i] ?? {};
    const settings = (entry.settings && typeof entry.settings === "object" ? entry.settings : {}) as Record<string, unknown>;
    await db.insert(schema.mediaServer).values({
      id: newEntityId("msrv"),
      name: typeof entry.name === "string" && entry.name ? entry.name : `Server ${i + 1}`,
      implementation: entry.implementation === "plex" || entry.implementation === "jellyfin" ? entry.implementation : "jellyfin",
      kind: "media",
      enabled: typeof entry.enabled === "boolean" ? entry.enabled : true,
      settings,
      createdAt: now,
      updatedAt: now,
    });
    result.mediaServers++;
  }

  // Superseded blob rows are fully migrated — drop them and set the sentinel so we
  // never run again (and never resurrect a since-deleted sink).
  await db.delete(schema.setting).where(inArray(schema.setting.key, keys));
  await db.insert(schema.setting).values({ key: SETTINGS_BLOB_MIGRATED_KEY, value: true, updatedAt: now });

  return result;
}
