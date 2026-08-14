// SPDX-License-Identifier: MIT
import { z } from "zod";

/** Quality sources (subset sufficient for the scaffold; extends later). */
export const qualitySourceSchema = z.enum([
  "unknown", "sd", "hdtv", "web", "bluray", "dvd",
]);
export const resolutionSchema = z.enum([
  "unknown", "480p", "576p", "720p", "1080p", "2160p",
]);

export const qualitySchema = z.object({
  source: qualitySourceSchema.default("unknown"),
  resolution: resolutionSchema.default("unknown"),
  edition: z.string().default(""),
});
export type Quality = z.infer<typeof qualitySchema>;
export type QualitySource = z.infer<typeof qualitySourceSchema>;
export type Resolution = z.infer<typeof resolutionSchema>;

/**
 * Ordered quality registry (gap report B4 / roadmap P0.2).
 *
 * Replaces the old `sourceRank*10 + resolutionRank` arithmetic, which put
 * `bluray/480p` above `web/2160p` and `dvd` above `web` — the only ranking
 * auto-grab used, so automation systematically preferred worse releases (bug I4).
 *
 * Every (source, resolution) pair the parser can produce gets one stable
 * integer id, generated once below from two ordered arrays. Resolution
 * dominates the order (a 2160p release always outranks any 480p release);
 * source only breaks ties within the same resolution. Comparison is then a
 * single index lookup (`qualityId`), not a formula evaluated at decision time.
 *
 * These ids are persisted (quality_profile.items/cutoffQualityId,
 * quality_definition.id) and the exact assignment is mirrored in migration
 * 0007 — do not reorder RESOLUTION_ORDER / SOURCE_ORDER without a new
 * migration to re-map existing rows.
 */
const RESOLUTION_ORDER: Resolution[] = ["unknown", "480p", "576p", "720p", "1080p", "2160p"];
const SOURCE_ORDER: QualitySource[] = ["unknown", "sd", "dvd", "hdtv", "web", "bluray"];

export interface QualityDefinitionMeta {
  id: number;
  key: string; // `${source}:${resolution}` — stable lookup key
  title: string;
  source: QualitySource;
  resolution: Resolution;
}

const SOURCE_LABEL: Record<QualitySource, string> = {
  unknown: "", sd: "SD", dvd: "DVD", hdtv: "HDTV", web: "WEB", bluray: "Bluray",
};

function title(source: QualitySource, resolution: Resolution): string {
  const s = SOURCE_LABEL[source];
  const r = resolution === "unknown" ? "" : resolution;
  return [s, r].filter(Boolean).join(" ") || "Unknown";
}

export const QUALITY_REGISTRY: readonly QualityDefinitionMeta[] = RESOLUTION_ORDER.flatMap(
  (resolution, resIdx) => SOURCE_ORDER.map((source, srcIdx): QualityDefinitionMeta => ({
    id: resIdx * SOURCE_ORDER.length + srcIdx,
    key: `${source}:${resolution}`,
    title: title(source, resolution),
    source,
    resolution,
  })),
);

const BY_KEY = new Map(QUALITY_REGISTRY.map((q) => [q.key, q]));
const BY_ID = new Map(QUALITY_REGISTRY.map((q) => [q.id, q]));

/** Resolve a parsed/reported quality to its registry id. Every (source, resolution)
 *  combination is covered by construction, so this never falls through. */
export function qualityId(q: Quality): number {
  return (BY_KEY.get(`${q.source}:${q.resolution}`) ?? BY_KEY.get("unknown:unknown")!).id;
}

export function qualityMeta(id: number): QualityDefinitionMeta | undefined {
  return BY_ID.get(id);
}

/** Global comparator: >0 if a outranks b, independent of any profile. Used where
 *  there's no profile context yet (e.g. picking among several already-allowed
 *  candidates). Profile-scoped ranking is `profilePosition`, below. */
export function compareQuality(a: Quality, b: Quality): number {
  return qualityId(a) - qualityId(b);
}

/**
 * Quality profiles are an ordered list of allowed quality ids (worst to best,
 * matching upstream's convention) plus a cutoff id. Allowed-ness and rank
 * within the profile are both a position lookup in `items` — no arithmetic.
 *
 * Custom-format scoring (roadmap P2) slots in later as a tiebreaker ahead of
 * this comparison; deliberately not built here.
 */
export const qualityProfileBaseSchema = z.object({
  name: z.string().min(1),
  items: z.array(z.number().int().min(0).max(QUALITY_REGISTRY.length - 1))
    .min(1, "at least one allowed quality"),
  cutoffQualityId: z.number().int().min(0).max(QUALITY_REGISTRY.length - 1),
  upgradeAllowed: z.boolean().default(true),
  language: z.string().default("en"),
  isDefault: z.boolean().default(false),
  /** Per-custom-format scores keyed by custom format id (roadmap P2). A format absent
   *  from the map contributes 0 regardless of whether it matches a release. */
  formatScores: z.record(z.string(), z.number().int()).default({}),
  /** Grab-side threshold: releases scoring below this are rejected, and the metric fed
   *  into the upgrade check. 0 disables the gate (matching every profile today). */
  minFormatScore: z.number().int().min(0).default(0),
  /** Upgrade-side cutoff: once an existing file's format score reaches this (while also
   *  meeting the quality cutoff), no further upgrades are wanted. 0 disables it. */
  cutoffFormatScore: z.number().int().min(0).default(0),
});
export const qualityProfileSchema = qualityProfileBaseSchema.refine((p) => p.items.includes(p.cutoffQualityId), {
  message: "cutoffQualityId must be one of items",
  path: ["cutoffQualityId"],
});
export type QualityProfileBody = z.infer<typeof qualityProfileSchema>;

/** Partial update body; the cutoff-in-items invariant is re-checked against the
 *  merged result at the service layer, since partial() can't carry the refine. */
export const updateQualityProfileSchema = qualityProfileBaseSchema.partial();
export type UpdateQualityProfileBody = z.infer<typeof updateQualityProfileSchema>;

export interface QualityProfileLike {
  items: number[];
  cutoffQualityId: number;
  /** Custom-format scores (P2). Absent when the caller only needs quality-level checks;
   *  the decision engine defaults missing scores to 0 so format behavior is inert until
   *  a profile actually configures formats. */
  formatScores?: Record<string, number>;
  minFormatScore?: number;
  cutoffFormatScore?: number;
}

/** Is this quality allowed at all by the profile? */
export function qualityAllowed(profile: QualityProfileLike, q: Quality): boolean {
  return profile.items.includes(qualityId(q));
}

/** Position of q within the profile's ordering (higher = better); -1 if not allowed. */
export function profilePosition(profile: QualityProfileLike, q: Quality): number {
  return profile.items.indexOf(qualityId(q));
}

/** Has this quality already reached (or passed) the profile's cutoff, i.e. no
 *  further upgrade is wanted? False for a quality the profile doesn't allow. */
export function meetsCutoff(profile: QualityProfileLike, q: Quality): boolean {
  const pos = profilePosition(profile, q);
  if (pos < 0) return false;
  const cutoffPos = profile.items.indexOf(profile.cutoffQualityId);
  return cutoffPos < 0 ? true : pos >= cutoffPos;
}
