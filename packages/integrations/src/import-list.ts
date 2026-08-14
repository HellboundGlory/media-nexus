// SPDX-License-Identifier: MIT
import type { ImportListContract } from "./contracts";
import type { TmdbProvider } from "./tmdb";

/** TMDb import list provider (roadmap P2, gap C2): adapts a TmdbProvider + listId into the
 *  generic ImportListContract. `externalId` is the tmdbId (string), which the app's
 *  metadata integration consumes when adding a title. */
export class TmdbImportListProvider implements ImportListContract {
  readonly key = "tmdb";
  constructor(private readonly tmdb: TmdbProvider, private readonly listId: string) {}

  async fetchItems(): Promise<Array<{ mediaType: "movie" | "series"; externalId: string; title?: string }>> {
    const items = await this.tmdb.listItems(this.listId);
    return items.map((it) => ({ mediaType: it.mediaType, externalId: String(it.tmdbId) }));
  }
}
