// SPDX-License-Identifier: MIT
import { Inject, Injectable } from "@nestjs/common";
import { randomBytes, createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import type { Principal } from "../common/principal";
import {
  ApiError,
  decryptSecret,
  encryptSecret,
  hashPassword,
  parseEnv,
  signSession,
  verifyPassword,
  verifySession,
} from "@medianexus/shared";

const ADMIN_ID = "admin";
const SESSION_PRINCIPAL_ID = "session:admin";

/**
 * Authentication is a single tier: a valid `X-Api-Key` is a system key with full
 * (admin) access. There are no user accounts/roles — this app is not public-facing.
 */
@Injectable()
export class AuthService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  hashApiKey(raw: string): string {
    return createHash("sha256").update(raw).digest("hex");
  }

  async authenticateKey(raw: string): Promise<Principal | null> {
    const hash = this.hashApiKey(raw);
    const row = await this.db.select().from(schema.apiKey).where(eq(schema.apiKey.keyHash, hash)).limit(1);
    if (row.length === 0) return null;
    const k = row[0];
    if (k.expiresAt && k.expiresAt < new Date().toISOString()) return null;
    void this.db
      .update(schema.apiKey)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(schema.apiKey.id, k.id))
      .catch(() => {});
    const scopes = k.scopes ?? [];
    return {
      keyId: k.id,
      isAdmin: scopes.includes("*"),
      scopes,
    };
  }

  async createApiKey(opts: { name: string; rawKey?: string }): Promise<{ id: string; rawKey: string }> {
    const rawKey = opts.rawKey ?? `mn_${randomBytes(24).toString("hex")}`;
    const id = `key_${randomBytes(8).toString("hex")}`;
    const { MEDIA_NEXUS_SECRET } = parseEnv();
    await this.db.insert(schema.apiKey).values({
      id,
      name: opts.name,
      keyHash: this.hashApiKey(rawKey),
      encryptedKey: encryptSecret(rawKey, MEDIA_NEXUS_SECRET),
      scopes: ["*"],
      createdAt: new Date().toISOString(),
    });
    return { id, rawKey };
  }

  async deleteApiKey(id: string): Promise<void> {
    await this.db.delete(schema.apiKey).where(eq(schema.apiKey.id, id));
  }

  /**
   * The system API key is a singleton (one row, regardless of how many times it's rotated) — used for
   * external/compat clients, not tied to whoever happens to be calling. Deliberately not scoped by
   * `req.principal.keyId`: a session-authenticated browser has no api_key row of its own (its principal's
   * keyId is a synthetic "session:admin"), so these operate on "the" row directly instead.
   */
  private async currentApiKeyRow() {
    const row = await this.db.select().from(schema.apiKey).limit(1);
    return row[0] ?? null;
  }

  /** Decrypts and returns the raw value of the system API key, or null if it predates encrypted storage (regenerate to enable reveal). */
  async revealApiKey(): Promise<string | null> {
    const row = await this.currentApiKeyRow();
    if (!row?.encryptedKey) return null;
    const { MEDIA_NEXUS_SECRET } = parseEnv();
    return decryptSecret(row.encryptedKey, MEDIA_NEXUS_SECRET);
  }

  /** Mints a new system API key and deletes the old one (create-then-delete: never a window with zero valid keys). */
  async regenerateApiKey(): Promise<{ rawKey: string }> {
    const existing = await this.currentApiKeyRow();
    const { rawKey } = await this.createApiKey({ name: "system (rotated)" });
    if (existing) await this.deleteApiKey(existing.id);
    return { rawKey };
  }

  // ---- browser login/session (separate from the api_key mechanism above,
  // which stays for external/compat clients) ----

  async hasAdminCredential(): Promise<boolean> {
    const row = await this.db.select().from(schema.adminCredential).limit(1);
    return row.length > 0;
  }

  /** First-run only: creates the single admin credential. Throws CONFLICT if one already exists. */
  async createAdminCredential(username: string, password: string): Promise<{ passwordVersion: number }> {
    if (await this.hasAdminCredential()) {
      throw new ApiError({ code: "CONFLICT", message: "An admin account already exists" });
    }
    const now = new Date().toISOString();
    await this.db.insert(schema.adminCredential).values({
      id: ADMIN_ID,
      username,
      passwordHash: hashPassword(password),
      passwordVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    return { passwordVersion: 1 };
  }

  /** Verifies username+password. Returns the credential's current passwordVersion (to sign into a session) or null. */
  async verifyLogin(username: string, password: string): Promise<{ passwordVersion: number } | null> {
    const row = await this.db.select().from(schema.adminCredential).where(eq(schema.adminCredential.id, ADMIN_ID)).limit(1);
    if (row.length === 0) return null;
    const cred = row[0];
    if (cred.username !== username || !verifyPassword(password, cred.passwordHash)) return null;
    return { passwordVersion: cred.passwordVersion };
  }

  /** Verifies current password, sets a new one, and bumps passwordVersion — invalidating every other session. */
  async changePassword(currentPassword: string, newPassword: string): Promise<{ passwordVersion: number }> {
    const row = await this.db.select().from(schema.adminCredential).where(eq(schema.adminCredential.id, ADMIN_ID)).limit(1);
    if (row.length === 0) throw new ApiError({ code: "NOT_FOUND", message: "No admin account exists" });
    const cred = row[0];
    if (!verifyPassword(currentPassword, cred.passwordHash)) {
      throw new ApiError({ code: "UNAUTHORIZED", message: "Current password is incorrect" });
    }
    const passwordVersion = cred.passwordVersion + 1;
    await this.db.update(schema.adminCredential).set({
      passwordHash: hashPassword(newPassword),
      passwordVersion,
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.adminCredential.id, ADMIN_ID));
    return { passwordVersion };
  }

  /** Signs a session cookie value for the given passwordVersion (call right after createAdminCredential/verifyLogin/changePassword). */
  issueSessionCookie(passwordVersion: number): string {
    const { MEDIA_NEXUS_SECRET } = parseEnv();
    return signSession(passwordVersion, MEDIA_NEXUS_SECRET);
  }

  /** Verifies a raw session cookie value (already extracted from the Cookie header) against the current passwordVersion. */
  async verifySessionCookie(cookieValue: string): Promise<Principal | null> {
    const { MEDIA_NEXUS_SECRET } = parseEnv();
    const payload = verifySession(cookieValue, MEDIA_NEXUS_SECRET);
    if (!payload) return null;
    const row = await this.db.select().from(schema.adminCredential).where(eq(schema.adminCredential.id, ADMIN_ID)).limit(1);
    if (row.length === 0 || row[0].passwordVersion !== payload.pv) return null;
    return { keyId: SESSION_PRINCIPAL_ID, isAdmin: true, scopes: ["*"] };
  }
}
