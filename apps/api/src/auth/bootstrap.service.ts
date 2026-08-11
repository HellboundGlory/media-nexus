// SPDX-License-Identifier: MIT
import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import { AuthService } from "./auth.service";

/**
 * First-run bootstrap: mints the single system API key used to access the app.
 * The raw value is printed once to logs; it can also be revealed later via
 * System → API key (see AuthService.revealApiKey).
 * Tests/dev may pin MEDIA_NEXUS_BOOTSTRAP_KEY.
 */
@Injectable()
export class BootstrapService implements OnModuleInit {
  private readonly logger = new Logger("Bootstrap");

  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly auth: AuthService,
  ) {}

  async onModuleInit(): Promise<void> {
    const existing = await this.db.select().from(schema.apiKey).limit(1);
    if (existing.length > 0) return;

    const rawKey = process.env.MEDIA_NEXUS_BOOTSTRAP_KEY ?? `mn_${randomBytes(24).toString("base64url")}`;
    await this.auth.createApiKey({ name: "bootstrap", rawKey });

    this.logger.warn("=====================================================");
    this.logger.warn(" MediaNexus first-run bootstrap");
    this.logger.warn(`   API key : ${rawKey}   (send as X-Api-Key header)`);
    this.logger.warn(" Store securely. You can view/copy it again later from System → API key.");
    this.logger.warn("=====================================================");
  }
}
