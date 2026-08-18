// SPDX-License-Identifier: MIT
import { z } from "zod";
import { qualitySchema } from "./quality";

/** Normalized search result — the native contract shared by every indexer provider. */
export const releaseSchema = z.object({
  id: z.string(),                 // provider-assigned stable id (guid)
  indexerId: z.string(),
  indexerName: z.string(),
  /** Indexer priority at fetch time — used as a release-comparison tiebreak when two
   *  indexers return an equivalent release (roadmap J7, gap report J7 finding 2).
   *  Sonarr/Prowlarr convention: LOWER number = HIGHER priority (1 best, 50 worst;
   *  schema default 25). Optional so releases constructed outside the fetch path stay valid. */
  indexerPriority: z.number().optional(),
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
  // Shared quality schema: source/resolution/edition + the RAD-010 modifier axis.
  quality: qualitySchema,
  isFreeleech: z.boolean().default(false),
  isProper: z.boolean().default(false),
  isRepack: z.boolean().default(false),
  // Indexer availability/ratio flags (SON-025b): the RAW volume factors as populated by each
  // provider from the Newznab/Torznab/Cardigann downloadvolumefactor/uploadvolumefactor
  // attributes — 0 = 100% free, 0.25 = 75% free, 0.5 = halfleech, 0.75 = 25% free, and an
  // upload factor >1 = double/bonus upload. `isFreeleech` stays the derived boolean
  // (downloadVolumeFactor === 0) for backward compat; these additive fields let indexerFlag
  // custom-format specs and the UI see the real numbers. Optional — most releases won't
  // carry them.
  downloadVolumeFactor: z.number().nonnegative().optional(),
  uploadVolumeFactor: z.number().nonnegative().optional(),
  /** Languages detected from the release title (ISO 639-1/639-2 codes). Optional so
   *  existing constructions without it stay valid; the custom-format matcher falls back
   *  to title detection when it's absent (roadmap P2). */
  languages: z.array(z.string()).optional(),
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
  // Manual-grab path (gap report I6): forward the full search result the caller already
  // has so `IndexersService.grab()` skips the hidden re-search round-trip (which would
  // otherwise double every manual grab's indexer load and rate-limit spend). The
  // grab-time decision re-evaluation still runs regardless; this only avoids the
  // redundant search, never the safety gate. Optional for backward compatibility with
  // callers (e.g. RSS auto-grab bypasses this DTO) that still omit it.
  release: releaseSchema.optional(),
});
export type GrabRequest = z.infer<typeof grabRequestSchema>;
