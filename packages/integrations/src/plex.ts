// SPDX-License-Identifier: MIT
/** Plex media server provider (local server HTTP API, X-Plex-Token auth). */
import type { MediaServerContract, ServerUser, Availability, HealthResult } from "./contracts";

export interface PlexSettings {
  host: string; // http://localhost:32400
  token: string; // X-Plex-Token
}

interface PlexGuid { id?: string }
interface PlexMetadataItem {
  ratingKey?: string;
  title?: string;
  guid?: string; // legacy single-agent guid, e.g. com.plexapp.agents.themoviedb://603?lang=en
  Guid?: PlexGuid[]; // modern multi-agent guids, e.g. { id: "tmdb://603" }
}
interface PlexSection {
  key?: string;
  type?: string; // "movie" | "show"
}

export class PlexMediaServerProvider implements MediaServerContract {
  readonly key = "plex";

  constructor(
    private readonly settings: PlexSettings,
    private readonly fetchImpl = fetch,
  ) {}

  private base(): string {
    return this.settings.host.replace(/\/$/, "");
  }
  private url(path: string, params: Record<string, string> = {}): string {
    const q = new URLSearchParams({ "X-Plex-Token": this.settings.token, ...params });
    return `${this.base()}${path}?${q.toString()}`;
  }
  private async getJson<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const res = await this.fetchImpl(this.url(path, params), { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Plex HTTP ${res.status} for ${path}`);
    return res.json() as Promise<T>;
  }

  private async sections(): Promise<PlexSection[]> {
    const data = await this.getJson<{ MediaContainer?: { Directory?: PlexSection[] } }>("/library/sections");
    return data.MediaContainer?.Directory ?? [];
  }

  /** tmdb/tvdb/imdb ids from either the modern multi-agent Guid array or the legacy single guid. */
  private extractIds(item: PlexMetadataItem): Record<string, string> {
    const out: Record<string, string> = {};
    for (const g of item.Guid ?? []) {
      const m = /^(tmdb|tvdb|imdb):\/\/(.+)$/.exec(g.id ?? "");
      if (m) out[m[1]] = m[2];
    }
    if (Object.keys(out).length === 0 && item.guid) {
      const tmdb = /themoviedb:\/\/(\d+)/.exec(item.guid);
      const tvdb = /thetvdb:\/\/(\d+)/.exec(item.guid);
      const imdb = /(tt\d+)/.exec(item.guid);
      if (tmdb) out.tmdb = tmdb[1];
      if (tvdb) out.tvdb = tvdb[1];
      if (imdb) out.imdb = imdb[1];
    }
    return out;
  }

  private async findAllItems(): Promise<Array<{ id: string; type: "Movie" | "Series"; providerIds: Record<string, string>; name: string }>> {
    const out: Array<{ id: string; type: "Movie" | "Series"; providerIds: Record<string, string>; name: string }> = [];
    for (const s of await this.sections()) {
      if ((s.type !== "movie" && s.type !== "show") || !s.key) continue;
      const data = await this.getJson<{ MediaContainer?: { Metadata?: PlexMetadataItem[] } }>(`/library/sections/${s.key}/all`);
      for (const item of data.MediaContainer?.Metadata ?? []) {
        const ids = this.extractIds(item);
        out.push({
          id: String(item.ratingKey ?? ""),
          type: s.type === "movie" ? "Movie" : "Series",
          providerIds: { ...(ids.tmdb ? { Tmdb: ids.tmdb } : {}), ...(ids.tvdb ? { Tvdb: ids.tvdb } : {}), ...(ids.imdb ? { Imdb: ids.imdb } : {}) },
          name: item.title ?? "",
        });
      }
    }
    return out;
  }

  /** Convenience for the availability refresh job (same shape Jellyfin's provider exposes). */
  async getLibraryItems(): Promise<Array<{ id: string; type: "Movie" | "Series"; providerIds: Record<string, string>; name: string }>> {
    return this.findAllItems();
  }

  async getAvailability(mediaType: "movie" | "series", externalId: string): Promise<Availability> {
    const items = await this.findAllItems();
    const match = items.find((it) =>
      mediaType === "movie"
        ? it.type === "Movie" && it.providerIds.Tmdb === externalId
        : it.type === "Series" && (it.providerIds.Tvdb === externalId || it.providerIds.Tmdb === externalId),
    );
    return match ? { present: true, serverId: match.id } : { present: false };
  }

  /** Local-server accounts only; full multi-user/watchlist needs plex.tv account linking (roadmap). */
  async importUsers(): Promise<ServerUser[]> {
    return [];
  }

  async scanLibrary(): Promise<{ scanned: number }> {
    const items = await this.findAllItems();
    return { scanned: items.length };
  }

  async healthcheck(): Promise<HealthResult> {
    const started = Date.now();
    try {
      const res = await this.fetchImpl(this.url("/identity"), { headers: { Accept: "application/json" } });
      return { ok: res.ok, latencyMs: Date.now() - started, message: res.ok ? undefined : `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, message: err instanceof Error ? err.message : String(err) };
    }
  }
}
