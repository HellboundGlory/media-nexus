// SPDX-License-Identifier: MIT
import { Inject, Injectable } from "@nestjs/common";
import { eq, desc } from "drizzle-orm";
import { ApiError, newEntityId } from "@medianexus/shared";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import type { CreateDownloadClient } from "@medianexus/domain";
import { ProvidersService } from "../providers/demo.providers";
import { redactSettings } from "../common/redact";
import {
  sabnzbdSettingsSchema,
  qbittorrentSettingsSchema,
  memoryClientSettingsSchema,
} from "@medianexus/integrations";
import { z } from "zod";

const settingsSchemas: Record<string, z.ZodType> = {
  sabnzbd: sabnzbdSettingsSchema,
  qbittorrent: qbittorrentSettingsSchema,
  memory: memoryClientSettingsSchema,
};

export const DOWNLOAD_CLIENT_IMPLEMENTATIONS = Object.keys(settingsSchemas);

@Injectable()
export class DownloadClientsService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly providers: ProvidersService,
  ) {}

  list() {
    return this.db.select().from(schema.downloadClient).orderBy(desc(schema.downloadClient.priority)).then((rows) =>
      rows.map((r) => ({ ...r, settings: redactSettings(r.settings) })),
    );
  }

  async get(id: string) {
    const rows = await this.db.select().from(schema.downloadClient).where(eq(schema.downloadClient.id, id)).limit(1);
    if (!rows[0]) throw ApiError.notFound("download client", id);
    return rows[0];
  }

  async create(input: CreateDownloadClient) {
    const schemaCfg = settingsSchemas[input.implementation];
    if (!schemaCfg) {
      throw new ApiError({
        code: "VALIDATION_ERROR",
        message: `Unsupported download client implementation "${input.implementation}" (supported: ${DOWNLOAD_CLIENT_IMPLEMENTATIONS.join(", ")})`,
      });
    }
    const parsed = schemaCfg.safeParse(input.settings);
    if (!parsed.success) {
      throw new ApiError({ code: "VALIDATION_ERROR", message: `Invalid settings for ${input.implementation}`, details: parsed.error.issues });
    }
    const now = new Date().toISOString();
    const kind = input.kind ?? (input.implementation === "sabnzbd" ? "usenet" : "torrent");
    const row = {
      id: newEntityId("dc"),
      name: input.name,
      implementation: input.implementation,
      kind,
      enabled: input.enabled ?? true,
      priority: input.priority ?? 1,
      settings: parsed.data as Record<string, unknown>,
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(schema.downloadClient).values(row);
    return row;
  }

  async remove(id: string) {
    await this.get(id);
    await this.db.delete(schema.downloadClient).where(eq(schema.downloadClient.id, id));
    return { removed: id };
  }

  /** Runs a live healthcheck against the provider built from the stored config. */
  async test(id: string) {
    const row = await this.get(id);
    const { provider } = (await this.providers.configuredDownloadClients()).find((c) => c.row?.id === id)
      ?? { provider: null };
    if (!provider) throw new ApiError({ code: "UNPROCESSABLE", message: "Provider not materializable" });
    const health = await provider.healthcheck();
    return { id, implementation: row.implementation, ...health };
  }
}
