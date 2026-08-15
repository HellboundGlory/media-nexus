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
  decryptNotificationSettings,
  decryptRuntimeSettings,
  decryptSecretValue,
  decryptSessionValue,
  encryptFields,
  encryptNotificationSettings,
  encryptRuntimeSettings,
  encryptSessionValue,
  encryptSettingValue,
  isEncrypted,
  INDEXER_SETTINGS_SECRET_FIELDS,
  DOWNLOAD_CLIENT_SECRET_FIELDS,
  MEDIA_SERVER_SECRET_FIELDS,
  NOTIFICATION_SECRET_FIELDS,
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
      "paths.downloads": "/downloads",
    } as never as import("@medianexus/shared").RuntimeSettings;

    const encrypted = encryptRuntimeSettings(settings, SECRET) as Record<string, any>;
    // credentials are no longer plaintext
    expect(encrypted["metadata.tmdbApiKey"]).not.toBe("tmdb-secret");
    // non-secret fields untouched
    expect(encrypted["paths.downloads"]).toBe("/downloads");

    const decrypted = decryptRuntimeSettings(encrypted as never, SECRET) as Record<string, any>;
    expect(decrypted["metadata.tmdbApiKey"]).toBe("tmdb-secret");
  });

  it("unknown keys pass through untouched", () => {
    expect(encryptSettingValue("paths.downloads", "/x", SECRET)).toBe("/x");
  });
});

describe("notification/media-server settings codec (gap J4/D7)", () => {
  it("per-kind notification settings encrypt/decrypt the right secret leaf fields", () => {
    expect(NOTIFICATION_SECRET_FIELDS.webhook).toEqual(["secret"]);
    expect(NOTIFICATION_SECRET_FIELDS.discord).toEqual(["webhookUrl"]);
    expect(NOTIFICATION_SECRET_FIELDS.telegram).toEqual(["botToken"]);
    expect(MEDIA_SERVER_SECRET_FIELDS).toEqual(["apiKey"]);

    const webhook = { url: "https://hook", secret: "wh-secret" };
    const enc = encryptNotificationSettings("webhook", webhook, SECRET) as any;
    expect(enc.secret).not.toBe("wh-secret");
    expect(enc.url).toBe("https://hook");
    expect((decryptNotificationSettings("webhook", enc, SECRET) as any).secret).toBe("wh-secret");

    const discord = { webhookUrl: "https://discord.com/api/webhooks/123/token" };
    const encD = encryptNotificationSettings("discord", discord, SECRET) as any;
    expect(encD.webhookUrl).not.toBe(discord.webhookUrl);
    expect((decryptNotificationSettings("discord", encD, SECRET) as any).webhookUrl).toBe(discord.webhookUrl);

    const tg = { botToken: "tg-tok", chatId: "77" };
    const encT = encryptNotificationSettings("telegram", tg, SECRET) as any;
    expect(encT.botToken).not.toBe("tg-tok");
    expect(encT.chatId).toBe("77");
    expect((decryptNotificationSettings("telegram", encT, SECRET) as any).botToken).toBe("tg-tok");
  });

  it("email's nested transport.auth.pass is the secret leaf field", () => {
    const email = { from: "a@b.c", to: ["x@y.z"], transport: { host: "smtp", port: 587, auth: { user: "u", pass: "mail-pass" } } };
    const enc = encryptNotificationSettings("email", email, SECRET) as any;
    expect(enc.transport.auth.pass).not.toBe("mail-pass");
    expect(enc.transport.auth.user).toBe("u");
    expect(enc.transport.host).toBe("smtp");
    const dec = decryptNotificationSettings("email", enc, SECRET) as any;
    expect(dec.transport.auth.pass).toBe("mail-pass");
    expect(dec.transport.auth.user).toBe("u");
  });

  it("tolerant: plaintext notification settings pass through decrypt unchanged", () => {
    const webhook = { url: "https://hook", secret: "wh-secret" };
    expect((decryptNotificationSettings("webhook", webhook, SECRET) as any).secret).toBe("wh-secret");
    const email = { from: "a", to: ["b"], transport: { host: "h", auth: { user: "u", pass: "p" } } };
    expect((decryptNotificationSettings("email", email, SECRET) as any).transport.auth.pass).toBe("p");
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
      key: "metadata.tmdbApiKey", value: "tmdb-plain", updatedAt: now,
    }).run();

    const result = runSecretBackfill(db, SECRET);
    expect(result.indexers).toBe(1);
    expect(result.clients).toBe(1);
    expect(result.settings).toBe(1);

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

    const tmdb = db.select().from(schema.setting).where(eq(schema.setting.key, "metadata.tmdbApiKey")).all()[0] as any;
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
      "metadata.tmdbApiKey": "tmdb-live",
    } as never);

    // stored form is encrypted
    const stored = db.select().from(schema.setting).all();
    const tmdb = stored.find((r) => r.key === "metadata.tmdbApiKey") as any;
    expect(tmdb.value).not.toBe("tmdb-live");
    expect(isEncrypted(tmdb.value, SECRET)).toBe(true);

    // read-back is plaintext (consumers see the real token)
    const got = await config.get();
    expect(got["metadata.tmdbApiKey"]).toBe("tmdb-live");
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

describe("Cardigann session value encryption (roadmap D4, Stage 2)", () => {
  it("round-trips a raw Cardigann session through the J9 AES-256-GCM codec", () => {
    const raw = JSON.stringify([{ name: "session", value: "abc123" }, { name: "uid", value: "5" }]);
    const encrypted = encryptSessionValue(raw, SECRET);
    expect(encrypted).not.toBe(raw);
    expect(decryptSessionValue(encrypted, SECRET)).toBe(raw);
    // tolerant: plaintext passes through
    expect(decryptSessionValue(raw, SECRET)).toBe(raw);
    // no secret → no encryption (pass-through)
    expect(encryptSessionValue(raw, undefined)).toBe(raw);
  });
});
