// SPDX-License-Identifier: MIT
import type { Release } from "@medianexus/domain";

// ---------- shared result types ----------
export interface HealthResult {
  ok: boolean;
  latencyMs?: number;
  message?: string;
}

// ---------- Indexer ----------
export interface SearchParams {
  mediaType: "movie" | "series";
  /** free-form query (title + year). If absent, category-only (RSS-style) search. */
  query?: string;
  categories?: number[];
  limit?: number;
  /** ID-based lookup support (roadmap P1, gap report D1): when present, a newznab/torznab
   *  provider uses the more precise `t=tvsearch` / `t=movie` modes instead of fuzzy
   *  `t=search`. `season`/`episode` narrow a tvsearch to a single episode. */
  tvdbId?: number | string;
  imdbId?: string;
  tmdbId?: number | string;
  season?: number;
  episode?: number;
}

export interface IndexerContract {
  readonly key: string;
  readonly protocol: "usenet" | "torrent";
  /** Normalized search over this indexer. Implementations translate into
   *  Newznab/Torznab/Cardigann wire formats; core never sees vendor shapes. */
  search(params: SearchParams): Promise<Release[]>;
  healthcheck(): Promise<HealthResult>;
  /** Optional session persistence surface (roadmap D4, Stage 2): providers that keep
   *  session/cookie state (e.g. Cardigann login) expose a raw serialized session here so the
   *  API layer can round-trip it through the database (encrypted at rest). Undefined when the
   *  provider has no session to persist. */
  readonly session?: string;
  /** Optional capability detection (`t=caps`): a normalized map of what this indexer
   *  instance supports (search modes, supported params, categories). Core persists it to
   *  the per-indexer `indexer.capabilities` column (not the shared `indexer_definition`
   *  row — instances sharing a definition can advertise different caps). Undefined = not
   *  supported. */
  capabilities?(): Promise<Record<string, unknown>>;
}

// ---------- Download client ----------
export interface AddDownloadInput {
  release: Release;
  /** destination directory hint (downloads root), if the client needs one */
  folder?: string;
  /** optional category/tag to apply (e.g. movies) */
  category?: string;
}

export interface ClientQueueItem {
  downloadId: string;
  title: string;
  status: string;
  progress: number; // 0..100
  size: number;
  remainingTimeSeconds?: number;
  errorMessage?: string;
  /** absolute path hint from the client (torrent content_path / nzb path) for import */
  contentPath?: string;
  /** Torrent seeding signal for the seed-goal policy (qbittorrent `ratio`,
   *  transmission `uploadRatio`). Undefined for clients that don't report it or
   *  for usenet. */
  ratio?: number;
  /** Torrent seconds spent seeding (qbittorrent `seeding_time`, transmission
   *  `secondsSeeding`). Undefined when the client doesn't report it (e.g. usenet). */
  seedTimeSeconds?: number;
}

export interface DownloadClientContract {
  readonly key: string;
  readonly kind: "usenet" | "torrent";
  addRelease(input: AddDownloadInput): Promise<{ downloadId: string }>;
  getQueue(): Promise<ClientQueueItem[]>;
  remove(downloadId: string, deleteData?: boolean): Promise<void>;
  healthcheck(): Promise<HealthResult>;
}

// ---------- Metadata ----------
export interface MediaSummary {
  externalId: string; // tmdb/tvdb id in the provider's native space
  title: string;
  originalTitle?: string;
  releaseDate?: string;
  year?: number;
  overview?: string;
  genres?: string[];
  images?: { coverType: string; url: string }[];
  rating?: number;
  // Detail-page additions (roadmap P3 / DETAILPAGE-BE1) — cheap, self-contained fields the
  // TMDB provider returns on one round trip; nullable because not every title/pipeline has them.
  /** TMDB's own lifecycle status, verbatim: "Released"/"Post Production"/"In Production" for
   *  movies; "Returning Series"/"Ended"/"Canceled"/... for series (SERIESSTATUS-2). */
  status?: string;
  /** Age/classification rating, e.g. "PG-13" (movie) / "TV-MA" (series). */
  certification?: string;
  /** Runtime in minutes (movie release runtime / series episode runtime). */
  runtime?: number;
  /** Production company name — movies only (no studio concept on series). */
  studio?: string;
  /** Release dates — three-way breakdown, movies only (series uses firstAirYear). */
  inCinemas?: string;
  digitalRelease?: string;
  physicalRelease?: string;
  /** YouTube video id of the primary trailer. */
  trailerId?: string;
  /** Movie collection the title belongs to (roadmap P3 / DETAILPAGE-BE3). Movies only — prefers
   *  `undefined` (not null) when a title has no collection, matching the rest of these fields. */
  collectionTmdbId?: number;
  collectionName?: string;
}

export interface MetadataProviderContract {
  readonly key: string;
  search(query: string, mediaType: "movie" | "series"): Promise<MediaSummary[]>;
  getDetails(mediaType: "movie" | "series", externalId: string): Promise<MediaSummary>;
  /** Optional cast & crew enrichment (roadmap P3 / DETAILPAGE-BE2). Optional because only TMDB
   *  implements it — a future non-TMDB provider doesn't have to. Splits the full cast list from
   *  a provider-curated subset of key crew jobs (the provider decides what's "key"; consumers
   *  shouldn't have to know a vendor's job taxonomy). */
  getCredits?(mediaType: "movie" | "series", externalId: string): Promise<{ cast: CreditPerson[]; crew: CreditPerson[] }>;
}

/** A single cast-or-crew credit (DETAILPAGE-BE2). Provider-agnostic — not TMDB-shaped. */
export interface CreditPerson {
  /** Stable person id (e.g. TMDB person id). */
  id: number;
  name: string;
  /** Cast only: role/character played. */
  character?: string;
  /** Crew only: the credited job (e.g. "Director"). */
  job?: string;
  /** Crew only: the department the job belongs to (e.g. "Directing"). */
  department?: string;
  /** Cast only: billing order, 0 = top-billed. */
  order?: number;
  /** Headshot URL, e.g. `https://image.tmdb.org/t/p/w185/...`; absent when the person has no photo. */
  profileUrl?: string;
}

// ---------- Import lists (roadmap P2, gap report C2) ----------
/** A watchlist source (Trakt list, TMDB list, Plex watchlist, ...) that a recurring sync
 *  pulls items from. `externalId` is the provider's stable id for the title (e.g. tmdbId
 *  for TMDB), in the id-space the app's metadata integration understands. Implementations
 *  are provider-specific; core never sees vendor shapes. */
export interface ImportListContract {
  readonly key: string;
  fetchItems(): Promise<Array<{ mediaType: "movie" | "series"; externalId: string; title?: string }>>;
}

// ---------- Media server ----------
export interface ServerUser {
  externalId: string;
  username: string;
  email?: string;
}
export interface Availability {
  present: boolean;
  serverId?: string;
}
export interface MediaServerContract {
  readonly key: string;
  getAvailability(mediaType: "movie" | "series", externalId: string): Promise<Availability>;
  importUsers(): Promise<ServerUser[]>;
  scanLibrary(): Promise<{ scanned: number }>;
  healthcheck(): Promise<HealthResult>;
}

// ---------- Notifications ----------
export interface NotificationMessage {
  eventType: string;
  title: string;
  body: string;
  meta: Record<string, unknown>;
}
export interface NotificationProviderContract {
  readonly key: string;
  deliver(message: NotificationMessage): Promise<void>;
  healthcheck(): Promise<HealthResult>;
}

// ---------- Auth ----------
export interface AuthExchangeResult {
  externalId: string;
  username: string;
  email?: string;
}
export interface AuthProviderContract {
  readonly key: string;
  /** Verify an OAuth/PAT exchange and return the user identity to upsert. */
  authenticate(exchangeToken: string): Promise<AuthExchangeResult>;
}

// ---------- Storage ----------
export interface StorageItem {
  path: string;
  size: number;
  isDirectory: boolean;
}
export interface StorageContract {
  readonly key: string;
  ensureDir(path: string): Promise<void>;
  list(path: string): Promise<StorageItem[]>;
  move(src: string, dst: string): Promise<void>;
  copy(src: string, dst: string): Promise<void>;
  hardlink(src: string, dst: string): Promise<boolean>;
  delete(path: string): Promise<void>;
  diskFree(path: string): Promise<{ free: number; total: number }>;
}

export type ProviderKind =
  | "indexer"
  | "downloadClient"
  | "metadata"
  | "mediaServer"
  | "notification"
  | "auth"
  | "storage";
