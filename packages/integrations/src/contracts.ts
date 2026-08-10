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
}

export interface IndexerContract {
  readonly key: string;
  readonly protocol: "usenet" | "torrent";
  /** Normalized search over this indexer. Implementations translate into
   *  Newznab/Torznab/Cardigann wire formats; core never sees vendor shapes. */
  search(params: SearchParams): Promise<Release[]>;
  healthcheck(): Promise<HealthResult>;
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
}

export interface MetadataProviderContract {
  readonly key: string;
  search(query: string, mediaType: "movie" | "series"): Promise<MediaSummary[]>;
  getDetails(mediaType: "movie" | "series", externalId: string): Promise<MediaSummary>;
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
