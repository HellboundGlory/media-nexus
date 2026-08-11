// SPDX-License-Identifier: MIT
import { Inject, Injectable } from "@nestjs/common";
import { randomBytes, createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import type { Principal } from "../common/principal";

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
    await this.db.insert(schema.apiKey).values({
      id,
      name: opts.name,
      keyHash: this.hashApiKey(rawKey),
      scopes: ["*"],
      createdAt: new Date().toISOString(),
    });
    return { id, rawKey };
  }

  async deleteApiKey(id: string): Promise<void> {
    await this.db.delete(schema.apiKey).where(eq(schema.apiKey.id, id));
  }
}
