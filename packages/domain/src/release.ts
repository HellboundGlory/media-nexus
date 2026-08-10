// SPDX-License-Identifier: MIT
import { z } from "zod";

/** Normalized search result — the native contract shared by every indexer provider. */
export const releaseSchema = z.object({
  id: z.string(),                 // provider-assigned stable id (guid)
  indexerId: z.string(),
  indexerName: z.string(),
  title: z.string(),
  protocol: z.enum(["usenet", "torrent"]),
  categories: z.array(z.number()).default([]),
  size: z.number().nonnegative().default(0),
  ageHours: z.number().nonnegative().default(0),
  seeders: z.number().nonnegative().nullish(),
  leechers: z.number().nonnegative().nullish(),
  peers: z.number().nonnegative().nullish(),
  downloadUrl: z.string().nullish(),
  magnetUrl: z.string().nullish(),
  infoUrl: z.string().nullish(),
  quality: z.object({
    source: z.enum(["unknown", "sd", "hdtv", "web", "bluray", "dvd"]),
    resolution: z.enum(["unknown", "480p", "576p", "720p", "1080p", "2160p"]),
    edition: z.string().default(""),
  }),
  isFreeleech: z.boolean().default(false),
  isProper: z.boolean().default(false),
  isRepack: z.boolean().default(false),
});
export type Release = z.infer<typeof releaseSchema>;

export const searchQuerySchema = z.object({
  mediaType: z.enum(["movie", "series"]),
  mediaId: z.string(),
  query: z.string().optional(),
  /** for series: restrict to specific seasons/episodes (builds an "SxxExx" query) */
  seasons: z.array(z.number().int().min(0)).optional(),
  episodes: z.array(z.number().int().min(1)).optional(),
  categories: z.array(z.number()).default([]),
  limit: z.number().int().positive().max(100).default(20),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

export const grabRequestSchema = z.object({
  mediaType: z.enum(["movie", "series"]),
  mediaId: z.string(),
  releaseId: z.string(),
  indexerId: z.string().optional(),
  downloadClientId: z.string().optional(),
});
export type GrabRequest = z.infer<typeof grabRequestSchema>;
