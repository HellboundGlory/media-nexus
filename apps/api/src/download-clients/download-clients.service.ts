// SPDX-License-Identifier: MIT
import { Inject, Injectable } from "@nestjs/common";
import { eq, desc } from "drizzle-orm";
import { ApiError, newEntityId } from "@medianexus/shared";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import type { CreateDownloadClient, UpdateDownloadClientBody } from "@medianexus/domain";
import { ProvidersService } from "../providers/demo.providers";
import { redactSettings, REDACTED } from "../common/redact";
import {
  sabnzbdSettingsSchema,
  qbittorrentSettingsSchema,
  transmissionSettingsSchema,
  nzbgetSettingsSchema,
  memoryClientSettingsSchema,
} from "@medianexus/integrations";
import { z } from "zod";
import { EventTypes } from "@medianexus/events";
import { EventsService } from "../events/events.service";
import { ProviderStatusService } from "../providers/provider-status.service";
import { DOWNLOAD_CLIENT_SECRET_FIELDS, decryptFields, encryptFields, getProviderSecret } from "../secrets/provider-secrets";

const settingsSchemas: Record<string, z.ZodType> = {
  sabnzbd: sabnzbdSettingsSchema,
  qbittorrent: qbittorrentSettingsSchema,
  transmission: transmissionSettingsSchema,
  nzbget: nzbgetSettingsSchema,
  memory: memoryClientSettingsSchema,
};

export const DOWNLOAD_CLIENT_IMPLEMENTATIONS = Object.keys(settingsSchemas);

@Injectable()
export class DownloadClientsService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly providers: ProvidersService,
    private readonly status: ProviderStatusService,
    private readonly events: EventsService,
  ) {}

  list() {
    return this.db.select().from(schema.downloadClient).orderBy(desc(schema.downloadClient.priority)).then((rows) =>
      rows.map((r) => ({ ...r, settings: redactSettings(r.settings) })),
    );
  }

  async get(id: string) {
    const rows = await this.db.select().from(schema.downloadClient).where(eq(schema.downloadClient.id, id)).limit(1);
    if (!rows[0]) throw ApiError.notFound("download client", id);
    // J9: never return stored ciphertext (or plaintext) for credential fields — redact,
    // matching `list()`. Internal callers (test/remove) only use `.id`, so this is safe.
    return { ...rows[0], settings: redactSettings(rows[0].settings) };
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
    const secret = getProviderSecret();
    const row = {
      id: newEntityId("dc"),
      name: input.name,
      implementation: input.implementation,
      kind,
      enabled: input.enabled ?? true,
      priority: input.priority ?? 1,
      // J9: store client credentials encrypted at rest (decrypted on read when providers are built).
      settings: encryptFields(parsed.data as Record<string, unknown>, DOWNLOAD_CLIENT_SECRET_FIELDS[input.implementation] ?? [], secret) as Record<string, unknown>,
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(schema.downloadClient).values(row);
    // J9: never return stored ciphertext for credential fields — redact, matching `list()`.
    return { ...row, settings: redactSettings(row.settings) };
  }

  /** Edit a download client (roadmap P1, gap report C5). Partial body; `settings` is
   *  J9-aware: stored (encrypted) secrets are decrypted, the client's plaintext values
   *  merged over them, re-validated against the provider schema, then re-encrypted — so an
   *  omitted or `[REDACTED]` secret is preserved and a new secret never lands in plaintext.
   *  Returns the redacted row. */
  async update(id: string, input: UpdateDownloadClientBody) {
    const rows = await this.db.select().from(schema.downloadClient).where(eq(schema.downloadClient.id, id)).limit(1);
    if (!rows[0]) throw ApiError.notFound("download client", id);
    const existing = rows[0];
    const secret = getProviderSecret();

    let settings = existing.settings;
    if (input.settings) {
      const fields = DOWNLOAD_CLIENT_SECRET_FIELDS[existing.implementation] ?? [];
      const decoded = decryptFields((existing.settings ?? {}) as Record<string, unknown>, fields, secret);
      const provided = input.settings as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...decoded, ...provided };
      for (const f of fields) if (provided[f] === REDACTED) merged[f] = decoded[f];
      const schemaCfg = settingsSchemas[existing.implementation];
      if (!schemaCfg) throw new ApiError({ code: "VALIDATION_ERROR", message: `Unsupported download client implementation "${existing.implementation}"` });
      const res = schemaCfg.safeParse(merged);
      if (!res.success) throw new ApiError({ code: "VALIDATION_ERROR", message: `Invalid settings for ${existing.implementation}`, details: res.error.issues });
      settings = encryptFields(res.data as Record<string, unknown>, fields, secret) as Record<string, unknown>;
    }

    const mergedRow = {
      name: input.name ?? existing.name,
      enabled: input.enabled ?? existing.enabled,
      priority: input.priority ?? existing.priority,
      tags: input.tags ?? existing.tags,
      settings,
      updatedAt: new Date().toISOString(),
    };
    await this.db.update(schema.downloadClient).set(mergedRow).where(eq(schema.downloadClient.id, id));
    // Session-reuse (J5/D3): the config changed, so drop the cached provider instance.
    this.providers.invalidateDownloadClient(id);
    const updated = { ...existing, ...mergedRow };
    return { ...updated, settings: redactSettings(updated.settings as Record<string, unknown>) };
  }

  async remove(id: string) {
    await this.get(id);
    await this.db.delete(schema.downloadClient).where(eq(schema.downloadClient.id, id));
    await this.status.clearProvider("downloadClient", id);
    this.providers.invalidateDownloadClient(id);
    return { removed: id };
  }

  /** Runs a live healthcheck against the provider built from the stored config.
   *  This is the download-client mirror of IndexersService.test() — the explicit recovery
   *  path (B10). Deliberately ungated by backoff so a manual test reaches a
   *  backed-off/auto-disabled client, and routes through
   *  ProviderStatusService.recordSuccess()/recordFailure() (the only recovery path that
   *  clears a download client's auto-disable). */
  async test(id: string) {
    const row = await this.get(id);
    const { provider } = (await this.providers.configuredDownloadClients()).find((c) => c.row?.id === id)
      ?? { provider: null };
    if (!provider) throw new ApiError({ code: "UNPROCESSABLE", message: "Provider not materializable" });
    const health = await provider.healthcheck();
    if (health.ok) {
      await this.status.recordSuccess("downloadClient", id);
    } else {
      await this.status.recordFailure("downloadClient", id, new Error(health.message ?? "healthcheck failed"));
      this.events.publish(EventTypes.DownloadClientFailed, { clientId: id, error: health.message ?? "healthcheck failed" });
    }
    return { id, implementation: row.implementation, ...health };
  }
}
