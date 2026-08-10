// SPDX-License-Identifier: MIT
import { Inject, Injectable, Logger } from "@nestjs/common";
import { randomBytes, createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import * as bcrypt from "bcryptjs";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import type { Principal } from "../common/principal";

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

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
    let user: (typeof schema.user.$inferSelect) | null = null;
    if (k.userId) {
      const users = await this.db.select().from(schema.user).where(eq(schema.user.id, k.userId)).limit(1);
      user = users[0] ?? null;
    }
    return {
      keyId: k.id,
      userId: k.userId ?? null,
      username: user?.username ?? null,
      isAdmin: user?.isAdmin ?? false,
      scopes: k.scopes ?? [],
    };
  }

  async createApiKey(opts: { name: string; userId?: string | null; rawKey?: string }): Promise<{ id: string; rawKey: string }> {
    const rawKey = opts.rawKey ?? `mn_${randomBytes(24).toString("hex")}`;
    const id = `key_${randomBytes(8).toString("hex")}`;
    await this.db.insert(schema.apiKey).values({
      id,
      userId: opts.userId ?? null,
      name: opts.name,
      keyHash: this.hashApiKey(rawKey),
      scopes: ["*"],
      createdAt: new Date().toISOString(),
    });
    return { id, rawKey };
  }

  async hashPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, 10);
  }

  async verifyPassword(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }
}
