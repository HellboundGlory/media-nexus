// SPDX-License-Identifier: MIT
/** Jellyfin media server provider (HTTP API) — reimplemented against Jellyfin's public API. */
import type { MediaServerContract, ServerUser, Availability, HealthResult } from "./contracts";

export interface JellyfinSettings {
  host: string; // http://localhost:8096
  apiKey: string;
  includeItemTypes?: string[]; // default ["Movie","Series"]
  libraries?: { name: string; id: string }[];
}

interface JfItem {
  Id?: string;
  Type?: string;
  Name?: string;
  ProviderIds?: Record<string, string>;
}

interface JfUser {
  Id?: string;
  Name?: string;
}

export class JellyfinMediaServerProvider implements MediaServerContract {
  readonly key = "jellyfin";

  constructor(
    private readonly settings: JellyfinSettings,
    private readonly fetchImpl = fetch,
  ) {}

  private base(): string {
    return this.settings.host.replace(/\/$/, "");
  }
  private url(path: string, params: Record<string, string> = {}): string {
    const q = new URLSearchParams({ api_key: this.settings.apiKey, ...params });
    return `${this.base()}${path}?${q.toString()}`;
  }

  async getAvailability(mediaType: "movie" | "series", externalId: string): Promise<Availability> {
    const types = (this.settings.includeItemTypes ?? ["Movie", "Series"]).join(",");
    let startIndex = 0;
    const limit = 200;
    while (startIndex < 4000) {
      const res = await this.fetchImpl(this.url("/Items", {
        Recursive: "true",
        IncludeItemTypes: types,
        StartIndex: String(startIndex),
        Limit: String(limit),
      }));
      if (!res.ok) throw new Error(`Jellyfin Items HTTP ${res.status}`);
      const data = (await res.json()) as { Items?: JfItem[]; TotalRecordCount?: number };
      const match = (data.Items ?? []).find((it) =>
        mediaType === "movie"
          ? it.ProviderIds?.Tmdb === externalId
          : it.ProviderIds?.Tvdb === externalId || it.ProviderIds?.Tmdb === externalId,
      );
      if (match) return { present: true, serverId: match.Id };
      const total = data.TotalRecordCount ?? 0;
      startIndex += limit;
      if (startIndex >= total) break;
    }
    return { present: false };
  }

  async importUsers(): Promise<ServerUser[]> {
    const res = await this.fetchImpl(this.url("/Users"));
    if (!res.ok) throw new Error(`Jellyfin Users HTTP ${res.status}`);
    const users = (await res.json()) as JfUser[];
    return users.map((u) => ({ externalId: String(u.Id), username: u.Name ?? "unknown" }));
  }

  async scanLibrary(): Promise<{ scanned: number }> {
    const items = await this.findAllItems();
    return { scanned: items.length };
  }

  /** Convenience for the availability refresh job: all library items with provider ids. */
  async getLibraryItems(): Promise<Array<{ id: string; type: "Movie" | "Series"; providerIds: Record<string, string>; name: string }>> {
    const items = await this.findAllItems();
    return items.map((it) => ({
      id: String(it.Id),
      type: (it.Type === "Movie" ? "Movie" : "Series") as "Movie" | "Series",
      providerIds: it.ProviderIds ?? {},
      name: it.Name ?? "",
    }));
  }

  async healthcheck(): Promise<HealthResult> {
    const started = Date.now();
    try {
      const res = await this.fetchImpl(this.url("/System/Info"));
      return { ok: res.ok, latencyMs: Date.now() - started, message: res.ok ? undefined : `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private async findAllItems(): Promise<JfItem[]> {
    const types = (this.settings.includeItemTypes ?? ["Movie", "Series"]).join(",");
    const all: JfItem[] = [];
    let startIndex = 0;
    const limit = 200;
    while (startIndex < 4000) {
      const res = await this.fetchImpl(this.url("/Items", { Recursive: "true", IncludeItemTypes: types, StartIndex: String(startIndex), Limit: String(limit) }));
      if (!res.ok) throw new Error(`Jellyfin Items HTTP ${res.status}`);
      const data = (await res.json()) as { Items?: JfItem[]; TotalRecordCount?: number };
      all.push(...(data.Items ?? []));
      const total = data.TotalRecordCount ?? 0;
      startIndex += limit;
      if (startIndex >= total) break;
    }
    return all;
  }
}
