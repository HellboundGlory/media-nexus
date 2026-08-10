// SPDX-License-Identifier: MIT
export interface Principal {
  keyId: string;
  userId: string | null;
  username: string | null;
  isAdmin: boolean;
  scopes: string[];
}

export interface Movie {
  id: string;
  tmdbId: number | null;
  imdbId: string | null;
  title: string;
  overview: string;
  status: string;
  releaseDate: string | null;
  monitored: boolean;
  qualityProfileId: string | null;
  rootFolderPath: string;
  genres: string[];
  tags: string[];
  hasFile: boolean;
  addedAt: string;
}

export interface Series {
  id: string;
  tvdbId: number | null;
  imdbId: string | null;
  title: string;
  overview: string;
  status: string;
  seriesType: string;
  firstAirYear: number | null;
  monitored: boolean;
  tags: string[];
  addedAt: string;
}

export interface Season {
  id: string;
  seriesId: string;
  seasonNumber: number;
  monitored: boolean;
}

export interface Episode {
  id: string;
  seriesId: string;
  seasonId: string;
  episodeNumber: number;
  absoluteNumber: number | null;
  title: string;
  airDateUtc: string | null;
  monitored: boolean;
  hasFile: boolean;
}

export interface WantedEpisode extends Episode {
  seasonNumber: number;
  seriesTitle: string;
}

export interface CalendarEntry {
  id: string;
  seriesId: string;
  seriesTitle: string;
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  airDateUtc: string;
  hasFile: boolean;
  monitored: boolean;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface SystemStatus {
  appName: string;
  version: string;
  started: string;
  uptimeSeconds: number;
  database: { vendor: string };
}

export interface RequestRow {
  id: string;
  userRequestorId: string | null;
  mediaType: "movie" | "series";
  mediaId: string;
  status: string;
  isAutoApproval: boolean;
  mediaTitle: string | null;
  requestedAt: string;
}

export interface HistoryRow {
  id: string;
  mediaType: string;
  mediaId: string;
  action: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface QueueRow {
  id: string;
  mediaType: string;
  mediaId: string;
  downloadId: string | null;
  title: string;
  status: string;
  progress: number;
  size: number;
  addedAt: string;
}

export interface Release {
  id: string;
  indexerId: string;
  indexerName: string;
  title: string;
  protocol: string;
  size: number;
  seeders: number | null;
  quality: { source: string; resolution: string };
}

export interface IndexerDef {
  id: string;
  key: string;
  name: string;
  protocol: string;
  implementation: string;
}

export interface IndexerRow {
  id: string;
  definitionKey: string;
  name: string;
  protocol: string;
  enabled: boolean;
  implementation: string;
  status: string;
}

export interface DownloadClient {
  id: string;
  name: string;
  implementation: string;
  kind: string;
  enabled: boolean;
  priority: number;
  settings: Record<string, unknown>;
  tags: string[];
  createdAt: string;
}

export interface IndexerRow {
  id: string;
  definitionKey: string;
  name: string;
  protocol: string;
  enabled: boolean;
  implementation: string;
  status: string;
}

export interface JobRun {
  id: string;
  jobKey: string;
  status: string;
  trigger: string;
  attempt: number;
  progress: number;
  message?: string;
  error?: string;
  finishedAt?: string;
  createdAt?: string;
}
