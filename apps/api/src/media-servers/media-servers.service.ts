// SPDX-License-Identifier: MIT
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, desc } from "drizzle-orm";
import { ApiError, newEntityId } from "@medianexus/shared";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import { redactSettings } from "../common/redact";
import { JellyfinMediaServerProvider, PlexMediaServerProvider } from "@medianexus/integrations";
import type { MediaServerContract } from "@medianexus/integrations";
import { decryptFields, encryptFields, getProviderSecret, MEDIA_SERVER_SECRET_FIELDS, mergeRedactionSentinels } from "../secrets/provider-secrets";
import { z } from "zod";
import type { MediaServerConfig } from "@medianexus/shared";
import type { TestMediaServerDraft } from "@medianexus/domain";

const settingsSchema = z.object({ host: z.string().min(1), apiKey: z.string().optional() });

/**
 * Media server availability: builds configured providers (Jellyfin/Plex) from real
 * `media_server` rows (roadmap P2, gap J4/D7, promoted from the `media.servers` setting
 * blob), refreshes `media_availability` against a real library server so the app knows
 * what's already available.
 */
@Injectable()
export class MediaServersService {
  private readonly logger = new Logger(MediaServersService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
  ) {}

  /** Build one provider from a media_server row's ALREADY-DECRYPTED plaintext settings.
   *  Single construction path shared by providers()/test()/testDraft() — callers decrypt.
   *  THROWS on an unknown implementation; hot-path callers on rows catch + skip. */
  private buildProvider(row: { implementation: string; settings: Record<string, unknown> }): MediaServerContract {
    return row.implementation === "plex"
      ? new PlexMediaServerProvider({ host: String(row.settings.host ?? ""), token: String(row.settings.apiKey ?? "") })
      : new JellyfinMediaServerProvider({ host: String(row.settings.host ?? ""), apiKey: String(row.settings.apiKey ?? "") });
  }

  async providers(): Promise<{ cfg: MediaServerConfig; provider: MediaServerContract }[]> {
    const rows = await this.db.select().from(schema.mediaServer).where(eq(schema.mediaServer.enabled, true));
    const secret = getProviderSecret();
    const out: { cfg: MediaServerConfig; provider: MediaServerContract }[] = [];
    for (const server of rows) {
      const settings = decryptFields(server.settings, MEDIA_SERVER_SECRET_FIELDS, secret) as Record<string, unknown>;
      out.push({
        cfg: {
          name: server.name,
          implementation: server.implementation as "jellyfin" | "plex",
          enabled: server.enabled,
          settings,
        },
        provider: this.buildProvider({ implementation: server.implementation, settings }),
      });
    }
    return out;
  }

  list() {
    return this.db.select().from(schema.mediaServer).orderBy(desc(schema.mediaServer.createdAt)).then((rows) =>
      rows.map((r) => ({ ...r, settings: redactSettings(r.settings) })),
    );
  }

  async get(id: string) {
    const rows = await this.db.select().from(schema.mediaServer).where(eq(schema.mediaServer.id, id)).limit(1);
    if (!rows[0]) throw ApiError.notFound("media server", id);
    return { ...rows[0], settings: redactSettings(rows[0].settings) };
  }

  async create(input: { name: string; implementation: "jellyfin" | "plex"; enabled?: boolean; settings?: Record<string, unknown> }) {
    const impl = input.implementation === "plex" ? "plex" : "jellyfin";
    const parsed = settingsSchema.safeParse(input.settings ?? {});
    if (!parsed.success) {
      throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid media server settings", details: parsed.error.issues });
    }
    const now = new Date().toISOString();
    const secret = getProviderSecret();
    const row = {
      id: newEntityId("msrv"),
      name: input.name,
      implementation: impl,
      kind: "media",
      enabled: input.enabled ?? true,
      settings: encryptFields(parsed.data, MEDIA_SERVER_SECRET_FIELDS, secret),
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(schema.mediaServer).values(row);
    return { ...row, settings: redactSettings(row.settings) };
  }

  /** Edit a media server (roadmap P2, gap J4/D7). Partial body; `settings.apiKey` is
   *  J9-aware: stored (encrypted) secret decrypted, client plaintext merged over it,
   *  re-validated, re-encrypted — `[REDACTED]` (or omitted) preserves the stored value. */
  async update(id: string, input: { name?: string; enabled?: boolean; settings?: Record<string, unknown> }) {
    const rows = await this.db.select().from(schema.mediaServer).where(eq(schema.mediaServer.id, id)).limit(1);
    if (!rows[0]) throw ApiError.notFound("media server", id);
    const existing = rows[0];
    const secret = getProviderSecret();

    let settings = existing.settings;
    if (input.settings) {
      const decoded = decryptFields(existing.settings, MEDIA_SERVER_SECRET_FIELDS, secret);
      const provided = input.settings;
      const merged = mergeRedactionSentinels(decoded, provided, MEDIA_SERVER_SECRET_FIELDS);
      const res = settingsSchema.safeParse(merged);
      if (!res.success) {
        throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid media server settings", details: res.error.issues });
      }
      settings = encryptFields(res.data, MEDIA_SERVER_SECRET_FIELDS, secret);
    }

    const mergedRow = {
      name: input.name ?? existing.name,
      enabled: input.enabled ?? existing.enabled,
      settings,
      updatedAt: new Date().toISOString(),
    };
    await this.db.update(schema.mediaServer).set(mergedRow).where(eq(schema.mediaServer.id, id));
    const updated = { ...existing, ...mergedRow };
    return { ...updated, settings: redactSettings(updated.settings as Record<string, unknown>) };
  }

  async remove(id: string) {
    await this.get(id);
    await this.db.delete(schema.mediaServer).where(eq(schema.mediaServer.id, id));
    return { removed: id };
  }

  /** Full library availability refresh across configured media servers. */
  async refreshAll(): Promise<{ servers: number; present: number }> {
    const providers = await this.providers();
    let present = 0;
    const now = new Date().toISOString();
    for (const { provider } of providers) {
      let items: { id: string; type: "Movie" | "Series"; providerIds: Record<string, string>; name: string }[] = [];
      try {
        if (provider instanceof JellyfinMediaServerProvider || provider instanceof PlexMediaServerProvider) items = await provider.getLibraryItems();
      } catch (err) {
        this.logger.warn(`media server scan failed: ${(err as Error).message}`);
        continue;
      }
      // movies by tmdb provider id; series by tvdb/tmdb provider id
      const movies = await this.db.select().from(schema.movie).where(eq(schema.movie.hasFile, false));
      const series = await this.db.select().from(schema.series);
      for (const m of movies) {
        if (m.tmdbId && items.some((it) => it.type === "Movie" && it.providerIds.Tmdb === String(m.tmdbId))) {
          await this.setAvailable("movie", m.id, now);
          present++;
        }
      }
      for (const s of series) {
        const hit = items.some((it) => it.type === "Series" && (it.providerIds.Tvdb === String(s.tvdbId) || (it.providerIds.Tmdb && s.tvdbId === null)));
        if (hit) { await this.setAvailable("series", s.id, now); present++; }
      }
    }
    return { servers: providers.length, present };
  }

  async setAvailable(mediaType: "movie" | "series", mediaId: string, now = new Date().toISOString()): Promise<void> {
    await this.db.update(schema.mediaAvailability)
      .set({ status: "available", lastAvailabilitySyncAt: now })
      .where(and(eq(schema.mediaAvailability.mediaType, mediaType), eq(schema.mediaAvailability.mediaId, mediaId)))
      .catch(() => {});
  }

  /** Live health-check on one configured media server (looked up by id). */
  async test(id: string): Promise<{ ok: boolean; message?: string }> {
    const rows = await this.db.select().from(schema.mediaServer).where(eq(schema.mediaServer.id, id)).limit(1);
    if (!rows[0]) return { ok: false, message: "not found" };
    const settings = decryptFields(rows[0].settings, MEDIA_SERVER_SECRET_FIELDS, getProviderSecret());
    const provider = this.buildProvider({ implementation: rows[0].implementation, settings });
    const h = await provider.healthcheck();
    return { ok: h.ok, message: h.message };
  }

  /**
   * Merge redaction sentinels for a draft test: if the provided settings contain `[REDACTED]`
   * for a secret leaf, keep the stored (decrypted) value. Returns the merged plaintext settings.
   * Uses the same shared J9 merge as update().
   */
  private mergeDraftMediaServerSettings(existing: typeof schema.mediaServer.$inferSelect, provided: Record<string, unknown>): Record<string, unknown> {
    const secret = getProviderSecret();
    const decoded = decryptFields(existing.settings, MEDIA_SERVER_SECRET_FIELDS, secret);
    return mergeRedactionSentinels(decoded, provided, MEDIA_SERVER_SECRET_FIELDS);
  }

  /**
   * Test a media server draft config without persisting anything.
   * Body: { id?, name, implementation, settings }
   * If id is provided, [REDACTED] secrets are resolved against the stored row.
   * Does NOT write anything to the DB.
   */
  async testDraft(input: TestMediaServerDraft): Promise<{ ok: boolean; message?: string }> {
    let settings: Record<string, unknown> = input.settings;

    if (input.id) {
      const rows = await this.db.select().from(schema.mediaServer).where(eq(schema.mediaServer.id, input.id)).limit(1);
      if (rows[0]) {
        settings = this.mergeDraftMediaServerSettings(rows[0], input.settings);
      }
    }

    // Validate settings
    const res = settingsSchema.safeParse(settings);
    if (!res.success) throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid media server settings", details: res.error.issues });

    // Build transient provider (same construction path as test()/providers()) and test
    const provider = this.buildProvider({ implementation: input.implementation, settings: res.data as Record<string, unknown> });
    const h = await provider.healthcheck();

    // CRITICAL: draft test must NOT persist anything
    return { ok: h.ok, message: h.message };
  }
}
