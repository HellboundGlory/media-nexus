// SPDX-License-Identifier: MIT
import { z } from "zod";
import { mediaTypeSchema } from "./media-type";

export const createMovieSchema = z.object({
  tmdbId: z.number().int().positive().optional(),
  imdbId: z.string().optional(),
  title: z.string().min(1),
  overview: z.string().default(""),
  releaseDate: z.string().optional(),
  monitored: z.boolean().default(true),
  qualityProfileId: z.string().optional(),
  rootFolderPath: z.string().default(""),
  tags: z.array(z.string()).default([]),
});
export type CreateMovie = z.infer<typeof createMovieSchema>;

export const createSeriesSchema = z.object({
  tvdbId: z.number().int().positive().optional(),
  imdbId: z.string().optional(),
  title: z.string().min(1),
  overview: z.string().default(""),
  firstAirYear: z.number().int().optional(),
  monitored: z.boolean().default(true),
  qualityProfileId: z.string().optional(),
  rootFolderPath: z.string().default(""),
  seriesType: z.enum(["standard", "daily", "anime"]).default("standard"),
  tags: z.array(z.string()).default([]),
});
export type CreateSeries = z.infer<typeof createSeriesSchema>;

export const createSeasonSchema = z.object({
  seasonNumber: z.number().int().min(0),
  monitored: z.boolean().default(true),
});

export const createDownloadClientSchema = z.object({
  name: z.string().min(1),
  implementation: z.string().min(1),
  enabled: z.boolean().default(true),
  kind: z.enum(["usenet", "torrent"]).optional(),
  priority: z.number().int().min(1).default(1),
  settings: z.record(z.string(), z.unknown()).default({}),
  tags: z.array(z.string()).default([]),
});
export type CreateDownloadClient = z.infer<typeof createDownloadClientSchema>;

/** Indexer config input — `settings` validated against provider schema at service level. */
export const createIndexerSchema = z.object({
  definitionKey: z.string().min(1),
  name: z.string().min(1),
  protocol: z.enum(["usenet", "torrent"]),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(1).default(25),
  settings: z.record(z.string(), z.unknown()).default({}),
  proxy: z.record(z.string(), z.unknown()).nullish(),
  tags: z.array(z.string()).default([]),
});
export type CreateIndexer = z.infer<typeof createIndexerSchema>;

export const createRequestSchema = z.object({
  mediaType: mediaTypeSchema,
  mediaId: z.string(),
  seasons: z.array(z.number().int().min(0)).default([]),
});
export type CreateRequest = z.infer<typeof createRequestSchema>;

export const upsertSettingSchema = z.record(z.string(), z.unknown());

/** Bootstrap user create (admin). */
export const createSystemUserSchema = z.object({
  username: z.string().min(3).max(64),
  password: z.string().min(8).max(256),
  email: z.string().email().optional(),
  isAdmin: z.boolean().default(true),
});
export type CreateSystemUser = z.infer<typeof createSystemUserSchema>;
