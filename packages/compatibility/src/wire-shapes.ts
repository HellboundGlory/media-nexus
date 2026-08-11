// SPDX-License-Identifier: MIT
// Upstream-documented wire shapes we translate TO for compatibility surfaces.
// These are the public API response shapes of Sonarr/Radarr/Prowlarr (v3/v3/v1).

export interface CompatSeries {
  id: string;
  title: string;
  tvdbId: number | null;
  imdbId?: string | null;
  status: string;
  seriesType: string;
  year: number | null;
  path: string;
  monitored: boolean;
  qualityProfileId: string | null;
  seasons?: { seasonNumber: number; monitored: boolean }[];
  images?: { coverType: string; url: string }[];
  added?: string;
  overview?: string;
}

export interface CompatMovie {
  id: string;
  title: string;
  tmdbId: number | null;
  imdbId?: string | null;
  status: string;
  year: number | null;
  path: string;
  monitored: boolean;
  qualityProfileId: string | null;
  images?: { coverType: string; url: string }[];
  added?: string;
  overview?: string;
  hasFile?: boolean;
}

export interface CompatQualityProfile {
  id: string;
  name: string;
  upgradeAllowed?: boolean;
  cutoff?: number;
  items?: unknown[];
  minFormatScore?: number;
  cutoffFormatScore?: number;
}

export interface CompatEpisode {
  seriesId: string;
  tvdbId?: number | null;
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  airDateUtc?: string | null;
  monitored: boolean;
  hasFile: boolean;
  id: string;
}

export interface CompatIndexerDef {
  id: string;
  name: string;
  fields: { name: string; value?: unknown }[];
  implementation: string;
  protocol: string;
  tags: number[];
  definitionName: string;
  configContract: string;
}

export interface CompatSearchResult {
  guid: string;
  title: string;
  size: number;
  seeders?: number | null;
  peers?: number | null;
  indexer: string;
  indexerId: number | string;
  categories: number[];
  magnetUrl?: string | null;
  downloadUrl?: string | null;
  publishDate?: string;
  protocol: string;
  infoUrl?: string | null;
}
