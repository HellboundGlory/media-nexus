// SPDX-License-Identifier: MIT
/**
 * Gap report J9 — idempotent, non-destructive in-place encryption of existing
 * plaintext provider credentials.
 *
 * Why this is a startup data pass and not a Drizzle SQL migration: encrypting a value
 * needs `MEDIA_NEXUS_SECRET` at runtime (`packages/shared/src/crypto.ts`), which a
 * `.sql` migration file cannot access. So this runs as an idempotent pass after
 * `runMigrations()` on boot: it walks every credential-bearing row, encrypts only the
 * fields still in plaintext (skipping anything already encrypted), and leaves everything
 * else untouched. Re-runs every boot and no-ops once every row is encrypted — it never
 * deletes, renames, or drops data, and never double-encrypts (`encryptSecretValue` +
 * `isEncrypted` guard).
 */
import { sql as dsql } from "drizzle-orm";
import { schema, type Db } from "@medianexus/database";
import { parseCardigannYaml } from "@medianexus/integrations";
import {
  DOWNLOAD_CLIENT_SECRET_FIELDS,
  INDEXER_SETTINGS_SECRET_FIELDS,
  PROXY_SECRET_FIELDS,
  SETTING_SECRET_KEYS,
  cardigannSecretFields,
  encryptFields,
  encryptSettingValue,
} from "./provider-secrets";

export interface SecretBackfillResult {
  /** Number of `indexer` rows whose settings/proxy were encrypted. */
  indexers: number;
  /** Number of `download_client` rows whose settings were encrypted. */
  clients: number;
  /** Number of `setting` rows whose value was encrypted. */
  settings: number;
}

export function runSecretBackfill(db: Db, secret: string): SecretBackfillResult {
  const result: SecretBackfillResult = { indexers: 0, clients: 0, settings: 0 };

  // --- indexers ---
  const defRows = db.select().from(schema.indexerDefinition).all();
  const defByKey = new Map(defRows.map((d) => [d.key, d.cardigannYml ? parseCardigannYaml(d.cardigannYml) : undefined]));
  const indexerRows = db.select().from(schema.indexer).all();
  for (const row of indexerRows) {
    const fields =
      row.implementation === "cardigann"
        ? cardigannSecretFields(defByKey.get(row.definitionKey))
        : (INDEXER_SETTINGS_SECRET_FIELDS[row.implementation] ?? []);
    const settings = encryptFields((row.settings ?? {}) as Record<string, unknown>, fields, secret);
    const proxy = row.proxy ? encryptFields(row.proxy as Record<string, unknown>, PROXY_SECRET_FIELDS, secret) : row.proxy;
    const settingsChanged = JSON.stringify(settings) !== JSON.stringify(row.settings);
    const proxyChanged = JSON.stringify(proxy) !== JSON.stringify(row.proxy);
    if (settingsChanged || proxyChanged) {
      db.update(schema.indexer)
        .set({ settings: settings as never, ...(proxyChanged ? { proxy: proxy as never } : {}) })
        .where(dsql`${schema.indexer.id} = ${row.id}`)
        .run();
      result.indexers++;
    }
  }

  // --- download clients ---
  const clientRows = db.select().from(schema.downloadClient).all();
  for (const row of clientRows) {
    const fields = DOWNLOAD_CLIENT_SECRET_FIELDS[row.implementation] ?? [];
    const settings = encryptFields((row.settings ?? {}) as Record<string, unknown>, fields, secret);
    if (JSON.stringify(settings) !== JSON.stringify(row.settings)) {
      db.update(schema.downloadClient)
        .set({ settings: settings as never })
        .where(dsql`${schema.downloadClient.id} = ${row.id}`)
        .run();
      result.clients++;
    }
  }

  // --- settings blob ---
  const keys = [...SETTING_SECRET_KEYS];
  const settingRows = db.select().from(schema.setting).where(dsql`${schema.setting.key} IN (${dsql.join(keys.map((k) => dsql`${k}`), dsql`, `)})`).all();
  for (const row of settingRows) {
    const encrypted = encryptSettingValue(row.key, row.value, secret);
    if (JSON.stringify(encrypted) !== JSON.stringify(row.value)) {
      db.update(schema.setting)
        .set({ value: encrypted })
        .where(dsql`${schema.setting.key} = ${row.key}`)
        .run();
      result.settings++;
    }
  }

  return result;
}
