// SPDX-License-Identifier: MIT
/**
 * Gap report J9 — provider credential encryption at rest.
 *
 * Covers the three layers added:
 *   1. The secret-field codec (`secrets/provider-secrets.ts`): idempotent encrypt,
 *      tolerant decrypt, round-trips, and non-secret fields untouched.
 *   2. The non-destructive, idempotent backfill (`secrets/secret-backfill.ts`) against a
 *      real SQLite DB — encrypts existing plaintext rows in place, preserves everything
 *      else, and no-ops on the second run.
 *   3. `ConfigService` settings-blob symmetry: `upsert()` stores credentials encrypted at
 *      rest in the `setting` table while `get()` returns plaintext to consumers.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb, schema, type Db } from "@medianexus/database";
import { ConfigService } from "../src/system/config.service";
import { DownloadClientsService } from "../src/download-clients/download-clients.service";
import { IndexersService } from "../src/indexers/indexers.service";
import {
  decryptFields,
  decryptRuntimeSettings,
  decryptSecretValue,
  decryptSettingValue,
  encryptFields,
  encryptRuntimeSettings,
  encryptSettingValue,
  isEncrypted,
  INDEXER_SETTINGS_SECRET_FIELDS,
  DOWNLOAD_CLIENT_SECRET_FIELDS,
} from "../src/secrets/provider-secrets";
import { runSecretBackfill } from "../src/secrets/secret-backfill";

process.env.MEDIA_NEXUS_SECRET = "test-secret-only";
const SECRET = "test-secret-only";

const dir = mkdtempSync(join(tmpdir(), "mn-secrets-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });

let counter = 0;
function freshDb(): Db {
  const handle = createDb(join(dir, `s-${counter++}.db`));
  handle.runMigrations();
  handles.push(handle);
  return handle.db;
}

describe("provider-secrets field codec", () => {
  it("round-trips an indexer settings blob", () => {
    const fields = ["apiKey", "password"];
    const plain = { baseUrl: "https://x", apiKey: "key-123", password: "pw", categories: [5000] };
    const encrypted = encryptFields(plain, fields, SECRET);
    expect(encrypted.apiKey).not.toBe("key-123");
    expect(isEncrypted(encrypted.apiKey as string, SECRET)).toBe(true);
    expect(encrypted.baseUrl).toBe("https://x"); // non-secret kept in plaintext
    expect(encrypted.categories).toEqual([5000]);
    const decrypted = decryptFields(encrypted, fields, SECRET);
    expect(decrypted.apiKey).toBe("key-123");
    expect(decrypted.password).toBe("pw");
  });

  it("encrypt is idempotent (no double encryption) and preserves ciphertext on re-run", () => {
    const plain = { apiKey: "key-123" };
    const once = encryptFields(plain, ["apiKey"], SECRET);
    const twice = encryptFields(once, ["apiKey"], SECRET);
    expect(twice.apiKey).toBe(once.apiKey); // already-encrypted value left as-is
    expect(decryptFields(twice, ["apiKey"], SECRET).apiKey).toBe("key-123");
  });

  it("decrypt is tolerant: plaintext (not yet migrated) passes through unchanged", () => {
    const plain = { apiKey: "key-123", baseUrl: "https://x" };
    expect(decryptFields(plain, ["apiKey"], SECRET).apiKey).toBe("key-123");
    expect(decryptSecretValue("not-encrypted", SECRET)).toBe("not-encrypted");
  });

  it("leaves non-string / empty secret fields untouched", () => {
    const plain = { apiKey: "", password: undefined as never, host: "h" };
    const encrypted = encryptFields(plain, ["apiKey", "password"], SECRET);
    expect(encrypted.apiKey).toBe("");
    expect(encrypted.password).toBeUndefined();
    expect(decryptFields(encrypted, ["apiKey", "password"], SECRET)).toEqual(plain);
  });

  it("does not encrypt a plaintext value that happens to match a key absent from the field list", () => {
    const plain = { username: "bob", password: "hunter2" };
    const encrypted = encryptFields(plain, ["apiKey"], SECRET); // password NOT in list
    expect(encrypted.password).toBe("hunter2");
  });

  it("indexer/download-client secret-field tables cover the expected keys", () => {
    expect(INDEXER_SETTINGS_SECRET_FIELDS.newznab).toEqual(["apiKey", "password"]);
    expect(INDEXER_SETTINGS_SECRET_FIELDS.torznab).toEqual(["apiKey", "password"]);
    expect(DOWNLOAD_CLIENT_SECRET_FIELDS.sabnzbd).toEqual(["apiKey"]);
    expect(DOWNLOAD_CLIENT_SECRET_FIELDS.qbittorrent).toEqual(["password"]);
  });
});

describe("settings-blob codec (RuntimeSettings)", () => {
  it("encrypts only the credential fields and decrypts them back to their original shape", () => {
    const settings = {
      "metadata.tmdbApiKey": "tmdb-secret",
      "notifications.webhooks": [{ url: "https://hook", secret: "wh-secret", eventTypes: [] }],
      "notifications.discord": [{ webhookUrl: "https://discord.com/api/webhooks/123/token", eventTypes: [] }],
      "notifications.telegram": [{ botToken: "tg-bot-token", chatId: "12345", eventTypes: [] }],
      "notifications.email": [{ from: "a@b.c", to: ["x@y.z"], subject: "s", eventTypes: [], transport: { host: "smtp", port: 587, secure: false, auth: { user: "u", pass: "mail-pass" } } }],
      "media.servers": [{ name: "sv", implementation: "jellyfin", enabled: true, settings: { host: "h", apiKey: "jf-token" } }],
      "paths.downloads": "/downloads",
    } as never as import("@medianexus/shared").RuntimeSettings;

    const encrypted = encryptRuntimeSettings(settings, SECRET) as Record<string, any>;
    // credentials are no longer plaintext
    expect(encrypted["metadata.tmdbApiKey"]).not.toBe("tmdb-secret");
    expect(encrypted["notifications.telegram"][0].botToken).not.toBe("tg-bot-token");
    expect(encrypted["notifications.email"][0].transport.auth.pass).not.toBe("mail-pass");
    expect(encrypted["notifications.discord"][0].webhookUrl).not.toBe("https://discord.com/api/webhooks/123/token");
    expect(encrypted["notifications.webhooks"][0].secret).not.toBe("wh-secret");
    expect(encrypted["media.servers"][0].settings.apiKey).not.toBe("jf-token");
    // non-secret fields untouched
    expect(encrypted["notifications.telegram"][0].chatId).toBe("12345");
    expect(encrypted["notifications.webhooks"][0].url).toBe("https://hook");
    expect(encrypted["notifications.email"][0].transport.auth.user).toBe("u");
    expect(encrypted["paths.downloads"]).toBe("/downloads");

    const decrypted = decryptRuntimeSettings(encrypted as never, SECRET) as Record<string, any>;
    expect(decrypted["metadata.tmdbApiKey"]).toBe("tmdb-secret");
    expect(decrypted["notifications.telegram"][0].botToken).toBe("tg-bot-token");
    expect(decrypted["notifications.email"][0].transport.auth.pass).toBe("mail-pass");
    expect(decrypted["notifications.discord"][0].webhookUrl).toBe("https://discord.com/api/webhooks/123/token");
    expect(decrypted["notifications.webhooks"][0].secret).toBe("wh-secret");
    expect(decrypted["media.servers"][0].settings.apiKey).toBe("jf-token");
  });

  it("per-key encrypt/decrypt setting helpers round-trip and tolerate plaintext", () => {
    const telegram = [{ botToken: "tok", chatId: "c", eventTypes: [] }];
    const encrypted = encryptSettingValue("notifications.telegram", telegram, SECRET) as any[];
    expect(encrypted[0].botToken).not.toBe("tok");
    expect((decryptSettingValue("notifications.telegram", encrypted, SECRET) as any[])[0].botToken).toBe("tok");
    // tolerant
    expect((decryptSettingValue("notifications.telegram", telegram, SECRET) as any[])[0].botToken).toBe("tok");
    // unknown key passes through untouched
    expect(encryptSettingValue("paths.downloads", "/x", SECRET)).toBe("/x");
  });
});

describe("secret backfill — non-destructive, idempotent", () => {
  it("encrypts existing plaintext indexer/client/setting rows in place and no-ops on re-run", () => {
    const db = freshDb();
    const now = new Date().toISOString();

    db.insert(schema.indexer).values({
      id: "idx1", definitionKey: "newznab", name: "Demo", protocol: "usenet", enabled: true,
      implementation: "newznab", settings: { baseUrl: "https://x", apiKey: "plain-key", password: "plain-pw" },
      proxy: { type: "http", host: "p", port: 8080, username: "u", password: "proxy-pw", enabled: true },
      priority: 25, status: "ok", tags: [], createdAt: now, updatedAt: now,
    }).run();
    db.insert(schema.downloadClient).values({
      id: "dc1", name: "qb", implementation: "qbittorrent", kind: "torrent", enabled: true,
      priority: 1, settings: { host: "https://h", username: "admin", password: "qb-pw" }, tags: [],
      createdAt: now, updatedAt: now,
    }).run();
    db.insert(schema.setting).values({
      key: "notifications.telegram", value: [{ botToken: "tg-tok", chatId: "1", eventTypes: [] }], updatedAt: now,
    }).run();
    db.insert(schema.setting).values({
      key: "metadata.tmdbApiKey", value: "tmdb-plain", updatedAt: now,
    }).run();

    const result = runSecretBackfill(db, SECRET);
    expect(result.indexers).toBe(1);
    expect(result.clients).toBe(1);
    expect(result.settings).toBe(2);

    const idx = db.select().from(schema.indexer).where(eq(schema.indexer.id, "idx1")).all();
    const idxRow = idx[0] as any;
    expect(idxRow.settings.baseUrl).toBe("https://x"); // preserved
    expect(idxRow.settings.apiKey).not.toBe("plain-key");
    expect(isEncrypted(idxRow.settings.apiKey, SECRET)).toBe(true);
    expect(isEncrypted(idxRow.settings.password, SECRET)).toBe(true);
    expect((idxRow.proxy as any).password).not.toBe("proxy-pw");
    expect((idxRow.proxy as any).username).toBe("u"); // username preserved

    const dc = db.select().from(schema.downloadClient).all()[0] as any;
    expect(dc.settings.username).toBe("admin"); // non-secret preserved
    expect(isEncrypted(dc.settings.password, SECRET)).toBe(true);

    const tg = db.select().from(schema.setting).where(eq(schema.setting.key, "notifications.telegram")).all()[0] as any;
    const tmdb = db.select().from(schema.setting).where(eq(schema.setting.key, "metadata.tmdbApiKey")).all()[0] as any;
    expect(tg.value[0].botToken).not.toBe("tg-tok");
    expect(tmdb.value).not.toBe("tmdb-plain");

    // idempotent: second run changes nothing
    const again = runSecretBackfill(db, SECRET);
    expect(again).toEqual({ indexers: 0, clients: 0, settings: 0 });
  });
});

describe("ConfigService settings-blob symmetry", () => {
  it("stores credentials encrypted at rest but returns plaintext via get()", async () => {
    const db = freshDb();
    const config = new ConfigService(db);

    await config.upsert({
      "notifications.telegram": [{ botToken: "tg-live", chatId: "77", eventTypes: [] }],
      "metadata.tmdbApiKey": "tmdb-live",
    } as never);

    // stored form is encrypted
    const stored = db.select().from(schema.setting).all();
    const tg = stored.find((r) => r.key === "notifications.telegram") as any;
    const tmdb = stored.find((r) => r.key === "metadata.tmdbApiKey") as any;
    expect(tg.value[0].botToken).not.toBe("tg-live");
    expect(isEncrypted(tg.value[0].botToken, SECRET)).toBe(true);
    expect(tmdb.value).not.toBe("tmdb-live");

    // read-back is plaintext (consumers see the real token)
    const got = await config.get();
    expect(got["notifications.telegram"][0].botToken).toBe("tg-live");
    expect(got["metadata.tmdbApiKey"]).toBe("tmdb-live");
    expect(got["notifications.telegram"][0].chatId).toBe("77");
  });

  it("re-upserting plaintext through get() does not double-encrypt", async () => {
    const db = freshDb();
    const config = new ConfigService(db);
    await config.upsert({ "metadata.tmdbApiKey": "k1" } as never);
    await config.upsert({ "paths.downloads": "/downloads" } as never); // second partial save
    const got = await config.get();
    expect(got["metadata.tmdbApiKey"]).toBe("k1");
    const stored = db.select().from(schema.setting).all().find((r) => r.key === "metadata.tmdbApiKey") as any;
    expect(isEncrypted(stored.value, SECRET)).toBe(true);
  });
});

describe("create()/get() never return raw credentials", () => {
  it("DownloadClientsService.create()/get() redact secret fields (no ciphertext, no plaintext)", async () => {
    const db = freshDb();
    const svc = new DownloadClientsService(db, {} as never, {} as never, {} as never);
    const created = await svc.create({
      name: "qb", implementation: "qbittorrent", kind: "torrent", enabled: true, priority: 1,
      settings: { host: "https://h", username: "admin", password: "QB-SECRET-PW" },
      tags: [],
    });
    // return shape is redacted — never the stored ciphertext and never the plaintext
    expect((created.settings as Record<string, unknown>).password).toBe("[REDACTED]");
    expect(JSON.stringify(created)).not.toContain("QB-SECRET-PW");
    expect((created.settings as Record<string, unknown>).host).toBe("https://h"); // non-secret preserved

    // the DB row really is encrypted at rest (contrast with the redacted response)
    const stored = db.select().from(schema.downloadClient).where(eq(schema.downloadClient.id, created.id)).all()[0] as any;
    expect(isEncrypted(stored.settings.password, SECRET)).toBe(true);

    const got = await svc.get(created.id);
    expect((got.settings as Record<string, unknown>).password).toBe("[REDACTED]");
    expect((got.settings as Record<string, unknown>).host).toBe("https://h");
  });

  it("IndexersService.create()/get() redact settings + proxy secret fields", async () => {
    const db = freshDb();
    const now = new Date().toISOString();
    db.insert(schema.indexerDefinition).values({
      id: "idef1", key: "generic-newznab", name: "GN", protocol: "usenet", implementation: "newznab",
      builtIn: true, capabilities: {}, categoryIds: [], cardigannYml: null, createdAt: now,
    }).run();
    const svc = new IndexersService(db, {} as never, {} as never, {} as never, {} as never, {} as never);
    const created = await svc.create({
      definitionKey: "generic-newznab", name: "idx", protocol: "usenet", enabled: true, priority: 25,
      settings: { baseUrl: "https://x", apiKey: "IDX-SECRET-KEY", password: "idx-pw" },
      proxy: { type: "http", host: "p", port: 8080, username: "u", password: "PROXY-SECRET-PW" },
      tags: [],
    });
    const body = JSON.stringify(created);
    expect((created.settings as Record<string, unknown>).apiKey).toBe("[REDACTED]");
    expect((created.proxy as Record<string, unknown> | null)?.password).toBe("[REDACTED]");
    expect(body).not.toContain("IDX-SECRET-KEY");
    expect(body).not.toContain("PROXY-SECRET-PW");
    expect((created.settings as Record<string, unknown>).baseUrl).toBe("https://x");

    // DB row is encrypted at rest
    const stored = db.select().from(schema.indexer).where(eq(schema.indexer.id, created.id)).all()[0] as any;
    expect(isEncrypted(stored.settings.apiKey, SECRET)).toBe(true);
    expect(isEncrypted(stored.proxy.password, SECRET)).toBe(true);

    const got = await svc.get(created.id);
    expect((got.settings as Record<string, unknown>).apiKey).toBe("[REDACTED]");
    expect((got.proxy as Record<string, unknown> | null)?.password).toBe("[REDACTED]");
    expect((got.settings as Record<string, unknown>).baseUrl).toBe("https://x");
  });
});
