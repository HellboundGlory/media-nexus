// SPDX-License-Identifier: MIT
import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import { AuthService } from "./auth.service";

/**
 * First-run bootstrap: creates the initial admin user and a one-time API key.
 * Only hashes are persisted; the raw values are printed once to logs.
 * Tests/dev may pin MEDIA_NEXUS_BOOTSTRAP_KEY / MEDIA_NEXUS_BOOTSTRAP_ADMIN_PASSWORD.
 */
@Injectable()
export class BootstrapService implements OnModuleInit {
  private readonly logger = new Logger("Bootstrap");

  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly auth: AuthService,
  ) {}

  async onModuleInit(): Promise<void> {
    const admins = await this.db.select().from(schema.user).where(eq(schema.user.isAdmin, true)).limit(1);
    if (admins.length > 0) return;

    const pw = process.env.MEDIA_NEXUS_BOOTSTRAP_ADMIN_PASSWORD ?? randomPassword();
    const passwordHash = await this.auth.hashPassword(pw);
    const now = new Date().toISOString();
    await this.db.insert(schema.user).values({
      id: "user_admin",
      username: "admin",
      email: "admin@localhost",
      passwordHash,
      isAdmin: true,
      roles: ["ADMIN"],
      createdAt: now,
      updatedAt: now,
    });
    const rawKey = process.env.MEDIA_NEXUS_BOOTSTRAP_KEY ?? `mn_${randomBytes(24).toString("base64url")}`;
    await this.auth.createApiKey({ name: "bootstrap-admin", userId: "user_admin", rawKey });

    this.logger.warn("=====================================================");
    this.logger.warn(" MediaNexus first-run bootstrap");
    this.logger.warn(`   admin user     : admin`);
    this.logger.warn(`   admin password : ${pw}`);
    this.logger.warn(`   API key        : ${rawKey}   (send as X-Api-Key header)`);
    this.logger.warn(" Store securely. Only hashes are persisted.");
    this.logger.warn("=====================================================");
  }
}

function randomPassword(): string {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789!@#$%";
  const bytes = randomBytes(18);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += chars[bytes[i] % chars.length];
  return out;
}
