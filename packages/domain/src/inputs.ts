// SPDX-License-Identifier: MIT
import { z } from "zod";
import { minimumAvailabilitySchema } from "./media";

export const createMovieSchema = z.object({
  tmdbId: z.number().int().positive().optional(),
  imdbId: z.string().optional(),
  title: z.string().min(1),
  overview: z.string().default(""),
  releaseDate: z.string().optional(),
  monitored: z.boolean().default(true),
  qualityProfileId: z.string().optional(),
  rootFolderPath: z.string().default(""),
  // Radarr's search-gate: "announced" (the historical hardcoded value here) always passes
  // hasMinimumAvailability(), so the default preserves every existing caller's behavior.
  // Movie automation (roadmap C1) is what gives this field real consequences.
  minimumAvailability: minimumAvailabilitySchema.default("announced"),
  tags: z.array(z.string()).default([]),
});
export type CreateMovie = z.infer<typeof createMovieSchema>;

export const createSeriesSchema = z.object({
  tvdbId: z.number().int().positive().optional(),
  tmdbId: z.number().int().positive().optional(),
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

/** Root folder input — `path` must be an accessible absolute directory, enforced at the
 *  service level (this schema only checks shape). */
export const createRootFolderSchema = z.object({
  path: z.string().min(1),
  name: z.string().default(""),
  isDefault: z.boolean().default(false),
});
export type CreateRootFolder = z.infer<typeof createRootFolderSchema>;

/** Remote path mapping input — translates a download client's self-reported content path
 *  into the path MediaNexus sees on its own filesystem (roadmap P1, gap report B8). */
export const createRemotePathMappingSchema = z.object({
  downloadClientId: z.string().min(1),
  remotePath: z.string().min(1),
  localPath: z.string().min(1),
});
export type CreateRemotePathMapping = z.infer<typeof createRemotePathMappingSchema>;

// ---------- Update (edit) schemas (roadmap P1, gap report C5) ----------
// Partial bodies — every field optional; the service merges onto the existing row.
// Deliberately defined explicitly (all `optional()`, no `.default()`) rather than as
// `.partial()` of a create schema, so an omitted field is never silently reset to a
// create-time default.

export const updateMovieSchema = z.object({
  title: z.string().min(1).optional(),
  monitored: z.boolean().optional(),
  qualityProfileId: z.string().nullish(),
  rootFolderPath: z.string().optional(),
  minimumAvailability: minimumAvailabilitySchema.optional(),
  tags: z.array(z.string()).optional(),
});
export type UpdateMovieBody = z.infer<typeof updateMovieSchema>;

export const updateSeriesSchema = z.object({
  title: z.string().min(1).optional(),
  monitored: z.boolean().optional(),
  seriesType: z.enum(["standard", "daily", "anime"]).optional(),
  qualityProfileId: z.string().nullish(),
  rootFolderPath: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
export type UpdateSeriesBody = z.infer<typeof updateSeriesSchema>;

export const updateIndexerSchema = z.object({
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(1).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  // null clears the proxy config; omitted leaves it unchanged; an object replaces it
  proxy: z.record(z.string(), z.unknown()).nullish(),
  tags: z.array(z.string()).optional(),
});
export type UpdateIndexerBody = z.infer<typeof updateIndexerSchema>;

export const updateDownloadClientSchema = z.object({
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(1).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
});
export type UpdateDownloadClientBody = z.infer<typeof updateDownloadClientSchema>;

export const updateRootFolderSchema = z.object({
  name: z.string().optional(),
  isDefault: z.boolean().optional(),
});
export type UpdateRootFolderBody = z.infer<typeof updateRootFolderSchema>;

export const updateRemotePathMappingSchema = z.object({
  remotePath: z.string().min(1).optional(),
  localPath: z.string().min(1).optional(),
});
export type UpdateRemotePathMappingBody = z.infer<typeof updateRemotePathMappingSchema>;

export const upsertSettingSchema = z.record(z.string(), z.unknown());

// ---------- Tags (roadmap P2, gap report C6) ----------
// Create/update bodies for the tag catalog. `id` is the stable key that entity `tags`
// arrays reference, so re-labelling/re-colouring never orphans the arrays.
export const createTagSchema = z.object({
  id: z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*$/, "Tag id must be alphanumeric with optional hyphens"),
  label: z.string().trim().min(1).optional(),
  color: z.string().trim().optional(),
});
export type CreateTag = z.infer<typeof createTagSchema>;

export const updateTagSchema = z.object({
  label: z.string().trim().min(1).optional(),
  color: z.string().trim().nullish(),
});
export type UpdateTag = z.infer<typeof updateTagSchema>;
