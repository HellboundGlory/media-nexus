// SPDX-License-Identifier: MIT
/**
 * Gap report J9 — encrypt provider credentials at rest.
 *
 * These helpers encrypt/decrypt the *secret leaf fields inside* a settings JSON blob,
 * keyed off `MEDIA_NEXUS_SECRET` (same AES-256-GCM as `packages/shared/src/crypto.ts`,
 * already proven in `apps/api/src/auth/auth.service.ts` for `api_key.encrypted_key`).
 * The rest of a settings object (baseUrl, categories, host, …) stays plaintext so the
 * UI can still display it; only the credential fields are encrypted.
 *
 * Two invariants make this safe to bolt onto existing write/read paths:
 *
 *  - **Idempotent encrypt** (`encryptSecretValue`): a value that already decrypts under
 *    the current secret is left alone, so re-running (or encrypting a row more than once)
 *    never double-encrypts.
 *  - **Tolerant decrypt** (`decryptSecretValue`): a value that fails to decrypt is returned
 *    unchanged (plaintext fallback), so a not-yet-encrypted row — e.g. one written mid-run
 *    before the startup backfill, or by the upstream importer — still yields workable
 *    plaintext instead of throwing.
 *
 * The `encrypt*`/`decrypt*` functions are pure (take `secret` as an arg) so they unit-test
 * cleanly; callers supply `parseEnv().MEDIA_NEXUS_SECRET` the same way `auth.service.ts` does.
 */
import { decryptSecret, encryptSecret, parseEnv } from "@medianexus/shared";
import type { RuntimeSettings } from "@medianexus/shared";

/**
 * Resolve the encryption secret without throwing. Production always sets `MEDIA_NEXUS_SECRET`
 * (enforced fail-fast by `main.ts` → `parseEnv()`), and every real encrypt/decrypt path supplies
 * a real secret here. Returning `undefined` (e.g. a test that never mentions the secret) makes
 * the codec a plaintext pass-through, so unrelated tests and pre-crypto callers are unaffected.
 */
export function getProviderSecret(): string | undefined {
  try {
    return parseEnv().MEDIA_NEXUS_SECRET;
  } catch {
    return undefined;
  }
}

/** True when `value` is already an `encryptSecret()` payload under `secret`. */
export function isEncrypted(value: string, secret: string | undefined): boolean {
  if (!secret || !value.includes(":")) return false;
  try {
    decryptSecret(value, secret);
    return true;
  } catch {
    return false;
  }
}

/** Encrypt a scalar if it is a non-empty plaintext string; idempotent. Non-strings unchanged. Returns the input when no secret. */
export function encryptSecretValue(value: unknown, secret: string | undefined): unknown {
  if (!secret || typeof value !== "string" || value.length === 0) return value;
  return isEncrypted(value, secret) ? value : encryptSecret(value, secret);
}

/** Decrypt a scalar if it is encrypted; tolerant — plaintext and non-strings pass through. Returns the input when no secret. */
export function decryptSecretValue(value: unknown, secret: string | undefined): unknown {
  if (!secret || typeof value !== "string" || value.length === 0) return value;
  return isEncrypted(value, secret) ? decryptSecret(value, secret) : value;
}

/** Shallow copy of `obj` with the named string fields encrypted (idempotent). No-op when no secret. */
export function encryptFields<T extends Record<string, unknown>>(
  obj: T,
  fields: readonly string[],
  secret: string | undefined,
): T {
  if (!secret || !fields.length) return obj;
  const out: Record<string, unknown> = { ...obj };
  for (const f of fields) if (f in out) out[f] = encryptSecretValue(out[f], secret);
  return out as T;
}

/** Shallow copy of `obj` with the named string fields decrypted (tolerant). No-op when no secret. */
export function decryptFields<T extends Record<string, unknown>>(
  obj: T,
  fields: readonly string[],
  secret: string | undefined,
): T {
  if (!secret || !fields.length) return obj;
  const out: Record<string, unknown> = { ...obj };
  for (const f of fields) if (f in out) out[f] = decryptSecretValue(out[f], secret);
  return out as T;
}

// Secret leaf fields per provider implementation (`settings` JSON blobs).
// `memory` is test infra only — no credentials.
export const INDEXER_SETTINGS_SECRET_FIELDS: Record<string, string[]> = {
  newznab: ["apiKey", "password"],
  torznab: ["apiKey", "password"],
  memory: [],
};

export const DOWNLOAD_CLIENT_SECRET_FIELDS: Record<string, string[]> = {
  sabnzbd: ["apiKey"],
  qbittorrent: ["password"],
  transmission: ["password"],
  nzbget: ["password"],
  memory: [],
};

/** `notification.settings` secret leaf fields per kind (flat fields only — email's
 *  `transport.auth.pass` is nested and handled bespoke by `encrypt/decryptNotificationSettings`). */
export const NOTIFICATION_SECRET_FIELDS: Record<string, string[]> = {
  webhook: ["secret"],
  discord: ["webhookUrl"],
  telegram: ["botToken"],
  email: [],
};

/** `media_server.settings` secret leaf field (matches `DOWNLOAD_CLIENT_SECRET_FIELDS` shape). */
export const MEDIA_SERVER_SECRET_FIELDS = ["apiKey"];

/** Encrypt the secret leaf field(s) of a `notification.settings` object for one kind.
 *  Idempotent + tolerant, mirroring `encryptSettingValue`. */
export function encryptNotificationSettings(kind: string, settings: unknown, secret: string | undefined): unknown {
  const s = (settings ?? {}) as Record<string, unknown>;
  if (kind === "email") {
    const t = s.transport as { auth?: { user?: string; pass?: string } } | undefined;
    return {
      ...s,
      ...(t
        ? {
            transport: {
              ...t,
              ...(t.auth ? { auth: { ...t.auth, pass: encryptSecretValue(t.auth.pass, secret) } } : {}),
            },
          }
        : {}),
    };
  }
  return encryptFields(s, NOTIFICATION_SECRET_FIELDS[kind] ?? [], secret);
}

/** Inverse of {@link encryptNotificationSettings} — tolerant decrypt, so plaintext passes through. */
export function decryptNotificationSettings(kind: string, settings: unknown, secret: string | undefined): unknown {
  const s = (settings ?? {}) as Record<string, unknown>;
  if (kind === "email") {
    const t = s.transport as { auth?: { user?: string; pass?: string } } | undefined;
    return {
      ...s,
      ...(t
        ? {
            transport: {
              ...t,
              ...(t.auth ? { auth: { ...t.auth, pass: decryptSecretValue(t.auth.pass, secret) } } : {}),
            },
          }
        : {}),
    };
  }
  return decryptFields(s, NOTIFICATION_SECRET_FIELDS[kind] ?? [], secret);
}

/** `indexer.proxy` secrets — the proxy password (username is not a credential). */
export const PROXY_SECRET_FIELDS = ["password"] as const;

/** Cardigann indexers: secret fields are the definition's password-typed settings. */
export function cardigannSecretFields(defs: { settings?: { name: string; type: string }[] } | undefined): string[] {
  return (defs?.settings ?? []).filter((s) => s.type === "password").map((s) => s.name);
}

/** Encrypt a Cardigann provider session (raw cookie-jar JSON) for at-rest storage (J9 AES-256-GCM). No-op when no secret. */
export function encryptSessionValue(raw: string | undefined, secret: string | undefined): string | undefined {
  if (!secret || !raw) return raw;
  return encryptSecret(raw, secret);
}

/** Decrypt a stored Cardigann session; tolerant — plaintext (or any un-decryptable value) passes through. */
export function decryptSessionValue(cipher: string | undefined, secret: string | undefined): string | undefined {
  if (!cipher || !secret) return cipher;
  try { return decryptSecret(cipher, secret); } catch { return cipher; }
}

// ---------- settings-blob (`setting` table) secret fields ----------

/** Setting-table keys that hold at-rest credentials. (The notification.* and media.servers
 *  keys were promoted to the `notification` and `media_server` tables — gap J4/D7 — so they
 *  no longer live in the settings blob; their secret fields are handled by the
 *  per-kind helpers operating on the new tables' `settings` column.) */
export const SETTING_SECRET_KEYS = new Set([
  "metadata.tmdbApiKey",
  "metadata.tvdbApiKey",
]);

/**
 * Encrypt the secret fields inside `value` for a single setting-table key. Only used for
 * keys in {@link SETTING_SECRET_KEYS}; any other key returns `value` unchanged. Works on a
 * single key's value (a JSON blob from a `setting` row), so both `encryptRuntimeSettings`
 * and the startup backfill can share it.
 */
export function encryptSettingValue(key: string, value: unknown, secret: string | undefined): unknown {
  switch (key) {
    case "metadata.tmdbApiKey":
      return encryptSecretValue(value, secret);
    case "metadata.tvdbApiKey":
      return encryptSecretValue(value, secret);
    default:
      return value;
  }
}

/** Inverse of {@link encryptSettingValue} — tolerant decrypt, so plaintext passes through. */
export function decryptSettingValue(key: string, value: unknown, secret: string | undefined): unknown {
  switch (key) {
    case "metadata.tmdbApiKey":
      return decryptSecretValue(value, secret);
    case "metadata.tvdbApiKey":
      return decryptSecretValue(value, secret);
    default:
      return value;
  }
}

/**
 * Encrypt the secret fields of a full `RuntimeSettings` object (the shape `ConfigService`
 * reads/writes). Only the credential fields are touched; every other key is copied through.
 * Returns a deep-`structuredClone`d copy, so the caller's object is never mutated.
 */
export function encryptRuntimeSettings(s: RuntimeSettings, secret: string | undefined): RuntimeSettings {
  const out: RuntimeSettings = structuredClone(s);
  for (const key of SETTING_SECRET_KEYS) {
    if (key in out) (out as Record<string, unknown>)[key] = encryptSettingValue(key, (out as Record<string, unknown>)[key], secret);
  }
  return out;
}

/** Inverse of {@link encryptRuntimeSettings}; tolerant decrypt, so plaintext passes through. */
export function decryptRuntimeSettings(s: RuntimeSettings, secret: string | undefined): RuntimeSettings {
  const out: RuntimeSettings = structuredClone(s);
  for (const key of SETTING_SECRET_KEYS) {
    if (key in out) (out as Record<string, unknown>)[key] = decryptSettingValue(key, (out as Record<string, unknown>)[key], secret);
  }
  return out;
}
