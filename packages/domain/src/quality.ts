// SPDX-License-Identifier: MIT
import { z } from "zod";

/** Quality sources (subset sufficient for the scaffold + the RAD-010 split).
 *  `webdl`/`webrip` are the granular values the parser now produces; `web` is the
 *  legacy coarse label KEPT so that pre-split persisted quality ids remap losslessly
 *  (an old "web" row is genuinely ambiguous between webdl and webrip — keeping the
 *  coarse value avoids guessing and corrupting an existing profile's ranking). */
export const qualitySourceSchema = z.enum([
  "unknown", "sd", "dvd", "hdtv", "web", "webdl", "webrip", "bluray",
]);
/** Orthogonal quality modifier axis (RAD-010): Remux/BR-DISK are NOT sources, they're a
 *  second axis applied to a source. Only the two values Hellbound's real formats use are
 *  modeled; CAM/TELESYNC/etc. and REGIONAL/SCREENER/RAWHD are deliberately out of scope. */
export const qualityModifierSchema = z.enum(["none", "brdisk", "remux"]);
export const resolutionSchema = z.enum([
  "unknown", "480p", "576p", "720p", "1080p", "2160p",
]);

// The zod object provides RUNTIME defaults (incl. modifier -> "none"). It is annotated to
// the optional-modifier `Quality` type so `z.infer<typeof qualitySchema>` and hand-built
// Quality literals agree (many pre-RAD-010 constructions omit the modifier axis); every read
// site normalizes `q.modifier ?? "none"`. See qualityId/compareQuality/modifier matching.
export const qualitySchema: z.ZodType<Quality> = z.object({
  source: qualitySourceSchema.default("unknown"),
  resolution: resolutionSchema.default("unknown"),
  edition: z.string().default(""),
  modifier: qualityModifierSchema.default("none"),
}) as z.ZodType<Quality>;
export type Quality = {
  source: QualitySource;
  resolution: Resolution;
  edition: string;
  modifier?: QualityModifier;
};
export type QualitySource = z.infer<typeof qualitySourceSchema>;
export type QualityModifier = z.infer<typeof qualityModifierSchema>;
export type Resolution = z.infer<typeof resolutionSchema>;

/**
 * Ordered quality registry (gap report B4 / roadmap P0.2, expanded by RAD-010).
 *
 * Replaces the old `sourceRank*10 + resolutionRank` arithmetic, which put
 * `bluray/480p` above `web/2160p` and `dvd` above `web` — the only ranking
 * auto-grab used, so automation systematically preferred worse releases (bug I4).
 *
 * Every (source, resolution, modifier) triple the parser can produce gets one stable
 * integer id, generated once below from three ordered arrays. Resolution dominates
 * the order (a 2160p release always outranks any 480p release); source then modifier
 * break ties within the same resolution. Comparison is then a single index lookup
 * (`qualityId`), not a formula evaluated at decision time.
 *
 * RAD-010 restructured this from a 6×6 2D grid to a 6×8×3 3D grid (source split
 * web→webdl/webrip, modifier=none/brdisk/remux added). Because the id arithmetic
 * depends on the array lengths (the row-stride changed), EVERY previously-persisted
 * quality id changes meaning — the id remap is done by a non-destructive startup
 * backfill (`apps/api/src/quality-profiles/quality-id-backfill.ts`, with the OLD
 * arrays kept as local references there), not by reordering these arrays again.
 */
const RESOLUTION_ORDER: Resolution[] = ["unknown", "480p", "576p", "720p", "1080p", "2160p"];
const SOURCE_ORDER: QualitySource[] = ["unknown", "sd", "dvd", "hdtv", "web", "webdl", "webrip", "bluray"];
// Within a source, plain < full-disc(brdisk) < remux — matches upstream's Modifier
// ordering (NONE < ... < BRDISK < REMUX) and Hellbound's "Remux as strict upgrade
// over plain Bluray at the same resolution".
const MODIFIER_ORDER: QualityModifier[] = ["none", "brdisk", "remux"];

export interface QualityDefinitionMeta {
  id: number;
  key: string; // `${source}:${resolution}:${modifier}` — stable lookup key
  title: string;
  source: QualitySource;
  resolution: Resolution;
  modifier: QualityModifier;
}

const SOURCE_LABEL: Record<QualitySource, string> = {
  unknown: "", sd: "SD", dvd: "DVD", hdtv: "HDTV", web: "WEB", webdl: "WEBDL", webrip: "WEBRip", bluray: "Bluray",
};
const MODIFIER_LABEL: Record<QualityModifier, string> = {
  none: "", brdisk: "BR-DISK", remux: "Remux",
};

function title(source: QualitySource, resolution: Resolution, modifier: QualityModifier): string {
  const base = [SOURCE_LABEL[source], resolution === "unknown" ? "" : resolution].filter(Boolean).join(" ") || "Unknown";
  return modifier === "none" ? base : `${base} ${MODIFIER_LABEL[modifier]}`;
}

export const QUALITY_REGISTRY: readonly QualityDefinitionMeta[] = RESOLUTION_ORDER.flatMap(
  (resolution, resIdx) => SOURCE_ORDER.flatMap((source, srcIdx) =>
    MODIFIER_ORDER.map((modifier, modIdx): QualityDefinitionMeta => ({
      id: resIdx * SOURCE_ORDER.length * MODIFIER_ORDER.length + srcIdx * MODIFIER_ORDER.length + modIdx,
      key: `${source}:${resolution}:${modifier}`,
      title: title(source, resolution, modifier),
      source,
      resolution,
      modifier,
    })),
  ),
);

const BY_KEY = new Map(QUALITY_REGISTRY.map((q) => [q.key, q]));
const BY_ID = new Map(QUALITY_REGISTRY.map((q) => [q.id, q]));

/** Resolve a parsed/reported quality to its registry id. Every (source, resolution,
 *  modifier) combination is covered by construction, so this never falls through. */
export function qualityId(q: Quality): number {
  const modifier = q.modifier ?? "none";
  return (BY_KEY.get(`${q.source}:${q.resolution}:${modifier}`) ?? BY_KEY.get("unknown:unknown:none")!).id;
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
