// SPDX-License-Identifier: MIT
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { schema } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";
import { ConfigService } from "../system/config.service";
import { redactDeep } from "../common/redact";
import type { MediaServerConfig } from "@medianexus/shared";
import { JellyfinMediaServerProvider, MemoryMediaServerProvider } from "@medianexus/integrations";
import type { MediaServerContract } from "@medianexus/integrations";

/**
 * Media server availability: builds configured providers (Jellyfin/memory),
 * refreshes `media_availability` against a real library server so the app knows
 * what's already available. Config lives in `media.servers` (validated in config).
 */
@Injectable()
export class MediaServersService {
  private readonly logger = new Logger(MediaServersService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly config: ConfigService,
  ) {}

  async providers(): Promise<{ cfg: MediaServerConfig; provider: MediaServerContract }[]> {
    const cfg = await this.config.get();
    const list = (cfg["media.servers"] ?? []) as MediaServerConfig[];
    const out: { cfg: MediaServerConfig; provider: MediaServerContract }[] = [];
    for (const server of list) {
      if (!server.enabled) continue;
      const settings = server.settings as Record<string, unknown>;
      const provider: MediaServerContract =
        server.implementation === "jellyfin"
          ? new JellyfinMediaServerProvider({
              host: String(settings.host ?? ""),
              apiKey: String(settings.apiKey ?? ""),
            })
          : new MemoryMediaServerProvider(Array.isArray(settings.present) ? (settings.present as never) : []);
      out.push({ cfg: server, provider });
    }
    return out;
  }

  listConfigured() {
    return this.config.get().then((c) => redactDeep(c["media.servers"] ?? []) as MediaServerConfig[]);
  }

  async saveConfigured(list: MediaServerConfig[]): Promise<MediaServerConfig[]> {
    await this.config.upsert({ "media.servers": list } as never);
    return list;
  }

  /** Full library availability refresh across configured media servers. */
  async refreshAll(): Promise<{ servers: number; present: number }> {
    const providers = await this.providers();
    let present = 0;
    const now = new Date().toISOString();
    for (const { provider } of providers) {
      let items: { id: string; type: "Movie" | "Series"; providerIds: Record<string, string>; name: string }[] = [];
      try {
        if (provider instanceof JellyfinMediaServerProvider) items = await provider.getLibraryItems();
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

  async testServer(idOrIndex: number): Promise<{ ok: boolean; message?: string }> {
    const providers = await this.providers();
    const entry = providers[idOrIndex];
    if (!entry) return { ok: false, message: "not found" };
    const h = await entry.provider.healthcheck();
    return { ok: h.ok, message: h.message };
  }
}
