// SPDX-License-Identifier: MIT
import { z } from "zod";
import type { Release } from "./release";
import { qualityModifierSchema, qualitySourceSchema, resolutionSchema, type Quality, type QualitySource, type QualityModifier, type Resolution } from "./quality";
import { parseLanguages, parseReleaseGroup } from "./parser";
import { parseEpisodeRelease } from "./episodes";

/**
 * Custom-format matching and scoring (roadmap P2, gap report B4/D6 + SON-025/RAD-010).
 *
 * A custom format is a named collection of `specs`. Each spec tests one thing about a
 * parsed release — a title term/regex, a size range, a language, a source/resolution/
 * modifier, a release group, a release type, or the indexer it came from.
 *
 * MATCHING ALGORITHM (SON-025 — this is the real upstream algorithm, from
 * `CustomFormatCalculationService.cs` + `SpecificationMatchesGroup.cs`):
 *   - A format's specs are grouped by their TYPE (all Source specs together, etc.).
 *   - A group "DidMatch" = `!( any(required member did NOT match) || all members did NOT match )`.
 *     i.e. same-type specs are OR'd together UNLESS one is marked `required`, in which case
 *     that member must also pass. Both conditions apply: a required member failing kills the
 *     group regardless of others, AND at least one member must have matched.
 *   - `negate` is applied per-spec BEFORE grouping (matchSpec returns the already-negated
 *     boolean); the grouping/required logic only ever sees that final per-spec boolean.
 *   - The format matches only if EVERY group's DidMatch is true (AND across different types).
 *
 *   The historical flat-AND `matchFormat` (every spec must pass, all types) made it
 *   impossible for a real tiered format to ever match — e.g. a format with N non-required
 *   same-type ReleaseGroup specs could never match any release (a release has one group).
 *   `required` was added (defaulting TRUE so pre-existing single-member formats behave
 *   exactly as before) to express the OR-sets community formats rely on.
 *
 * This is the pure, DB-free core upstream Sonarr/Radarr express as
 * `CustomFormatCalculationService` + the individual `*Specification` classes — here
 * collapsed into one shared implementation (no movie-vs-episode duplication). The API
 * layer (`DecisionService`) loads the format definitions and the media's profile
 * scores and hands them to the decision engine; nothing in this file touches the DB.
 *
 * Specs evaluate against a `CustomFormatMatchInput` — the parts of a release the
 * specs are allowed to look at. Releases supply the full view. An *existing library
 * file* only has what `media_file` stores (its filename, size, parsed quality), so it
 * is scored from a reduced view: title-term, size, release-group and release-type
 * specs can match from the filename, but language and indexer specs cannot — a
 * conservative floor.
 */

export const customFormatSpecSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("term"),
    /** Substring or regex to search the release title for (e.g. "x265", "REMUX", "dts"). */
    term: z.string().min(1),
    /** Treat `term` as a regular expression rather than a plain substring. */
    useRegex: z.boolean().default(false),
    /** Invert the match — the format matches when the term is NOT present. */
    negate: z.boolean().default(false),
    /** This member must pass for its same-type group to pass (see algorithm above). */
    required: z.boolean().default(true),
    caseSensitive: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("size"),
    /** Inclusive lower bound in bytes. */
    min: z.number().nonnegative().optional(),
    /** Inclusive upper bound in bytes. */
    max: z.number().nonnegative().optional(),
    negate: z.boolean().default(false),
    required: z.boolean().default(true),
    caseSensitive: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("language"),
    /** ISO 639-1 / 639-2 code present on the release (e.g. "en", "fr", "de"). */
    language: z.string().min(1),
    negate: z.boolean().default(false),
    required: z.boolean().default(true),
    caseSensitive: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("indexer"),
    /** Indexer id the release must (or must not) have come from. */
    indexerId: z.string().min(1),
    negate: z.boolean().default(false),
    required: z.boolean().default(true),
    caseSensitive: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("resolution"),
    /** Release resolution the spec matches (compared to input.quality.resolution). */
    resolution: resolutionSchema,
    negate: z.boolean().default(false),
    required: z.boolean().default(true),
    caseSensitive: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("source"),
    /** Release source the spec matches (compared to input.quality.source). "Web"/"WebDL"/
     *  "WebRip"/"Bluray"/etc. — the RAD-010 granular values. */
    source: qualitySourceSchema,
    negate: z.boolean().default(false),
    required: z.boolean().default(true),
    caseSensitive: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("modifier"),
    /** Release modifier the spec matches (compared to input.quality.modifier): none/brdisk/
     *  remux. Lets "Not Remux" / "Full Disc (BRDISK)" be expressed as conditions. */
    modifier: qualityModifierSchema,
    negate: z.boolean().default(false),
    required: z.boolean().default(true),
    caseSensitive: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("releaseGroup"),
    /** The trailing release group token (e.g. "DON", "RARBG") or, with useRegex, a regex
     *  pattern the parsed group is matched against (upstream's ReleaseGroupSpecification
     *  value is always a regex). */
    releaseGroup: z.string().min(1),
    useRegex: z.boolean().default(false),
    negate: z.boolean().default(false),
    required: z.boolean().default(true),
    caseSensitive: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("releaseType"),
    /** Series-only: single episode / multi-episode / season pack. A movie release has no
     *  release type and never satisfies this spec (see releaseTypeMatches). */
    releaseType: z.enum(["single", "multi", "season"]),
    negate: z.boolean().default(false),
    required: z.boolean().default(true),
    caseSensitive: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("indexerFlag"),
    /** Availability/ratio flag derived from the release's volume factors (SON-025b). The
     *  threshold mapping lives in `releaseFlagMatches` so it can never drift from the UI labels.
     *  Full 9-value set (MANAGEFILES-1) matching upstream's `IndexerFlags` [Flags] enum, though
     *  only the five volume-factor flags are ever derivable from a release here. */
    flag: z.enum(["freeleech", "freeleech75", "halfleech", "freeleech25", "doubleUpload", "internal", "scene", "nuked", "subtitles"]),
    negate: z.boolean().default(false),
    required: z.boolean().default(true),
    caseSensitive: z.boolean().default(false),
  }),
]);
export type CustomFormatSpec =
  | { type: "term"; term: string; useRegex?: boolean; negate?: boolean; required?: boolean; caseSensitive?: boolean }
  | { type: "size"; min?: number; max?: number; negate?: boolean; required?: boolean; caseSensitive?: boolean }
  | { type: "language"; language: string; negate?: boolean; required?: boolean; caseSensitive?: boolean }
  | { type: "indexer"; indexerId: string; negate?: boolean; required?: boolean; caseSensitive?: boolean }
  | { type: "resolution"; resolution: Resolution; negate?: boolean; required?: boolean; caseSensitive?: boolean }
  | { type: "source"; source: QualitySource; negate?: boolean; required?: boolean; caseSensitive?: boolean }
  | { type: "modifier"; modifier: QualityModifier; negate?: boolean; required?: boolean; caseSensitive?: boolean }
  | { type: "releaseGroup"; releaseGroup: string; useRegex?: boolean; negate?: boolean; required?: boolean; caseSensitive?: boolean }
  | { type: "releaseType"; releaseType: ReleaseTypeValue; negate?: boolean; required?: boolean; caseSensitive?: boolean }
  | { type: "indexerFlag"; flag: IndexerFlagValue; negate?: boolean; required?: boolean; caseSensitive?: boolean };
export type ReleaseTypeValue = "single" | "multi" | "season";
/** Indexer flags (NzbDrone.Core.Parser.Model.IndexerFlags) — the full 9-value set, stored as a
 *  single bitmask int on a media_file row (MANAGEFILES-1). Only the five volume-factor flags are
 *  also derivable from a release's volume data (see `releaseFlagMatches`); internal/scene/nuked/
 *  subtitles are metadata-only and persist purely as user-set bits. */
export type IndexerFlagValue = "freeleech" | "freeleech75" | "halfleech" | "freeleech25" | "doubleUpload" | "internal" | "scene" | "nuked" | "subtitles";

/** The 9-value flag catalog: value (domain name), bit (the mask value stored in the int) and the
 *  display label. Values match upstream exactly; the single source the API and any mirroring UI
 *  derive their picker/display lists from, so a flag's bit and label can never drift. */
export const INDEXER_FLAGS: readonly { value: IndexerFlagValue; bit: number; label: string }[] = [
  { value: "freeleech", bit: 1, label: "Freeleech" },
  { value: "halfleech", bit: 2, label: "Halfleech" },
  { value: "doubleUpload", bit: 4, label: "Double Upload" },
  { value: "internal", bit: 8, label: "Internal" },
  { value: "scene", bit: 16, label: "Scene" },
  { value: "freeleech75", bit: 32, label: "Freeleech 75%" },
  { value: "freeleech25", bit: 64, label: "Freeleech 25%" },
  { value: "nuked", bit: 128, label: "Nuked" },
  { value: "subtitles", bit: 256, label: "Subtitles" },
];

export const customFormatSchema = z.object({
  name: z.string().min(1),
  specs: z.array(customFormatSpecSchema).min(1, "a custom format needs at least one spec"),
});
export type CustomFormatBody = z.infer<typeof customFormatSchema>;

/** Partial update; the non-empty-specs invariant is re-checked at the service layer
 *  against the merged result, since partial() can't carry the array min(). */
export const updateCustomFormatSchema = z.object({
  name: z.string().min(1).optional(),
  specs: z.array(customFormatSpecSchema).min(1, "a custom format needs at least one spec").optional(),
});
export type UpdateCustomFormatBody = z.infer<typeof updateCustomFormatSchema>;

/**
 * The complete custom format as stored and scored: identity plus its specs. `id` is
 * the stable key that quality profiles reference in their `formatScores` map.
 */
export interface CustomFormat {
  id: string;
  name: string;
  specs: CustomFormatSpec[];
}

/** The parts of a release a spec is allowed to examine. See file header. */
export interface CustomFormatMatchInput {
  title: string;
  size: number;
  quality: Quality;
  languages: string[];
  /** Present for live releases; absent when scoring an existing library file. */
  indexerId?: string;
  /** Trailing release-group token parsed from the title/filename (undefined when none
   *  was confidently parsed — releaseGroup specs then cannot match non-negated). */
  releaseGroup?: string;
  /** Series release type derived from episode multiplicity; undefined for a movie or
   *  a title that names no episode (releaseType specs never satisfy an undefined input). */
  releaseType?: ReleaseTypeValue;
  /** Raw indexer volume factors (SON-025b). Present for live releases; absent when scoring an
   *  existing library file (its metadata is gone — indexerFlag specs behave like language/indexer
   *  specs there: non-negated never matches, negated always matches). */
  downloadVolumeFactor?: number;
  uploadVolumeFactor?: number;
}

export function releaseMatchInput(release: Release): CustomFormatMatchInput {
  return {
    title: release.title,
    size: release.size,
    quality: release.quality,
    // A release that didn't have `languages` populated at build time is still scored
    // against language terms by detecting languages from its title — conservative but
    // correct (parseLanguages returns [] rather than guessing).
    languages: release.languages?.length ? release.languages : parseLanguages(release.title),
    indexerId: release.indexerId,
    releaseGroup: parseReleaseGroup(release.title) ?? undefined,
    releaseType: deriveReleaseType(release.title),
    downloadVolumeFactor: release.downloadVolumeFactor,
    uploadVolumeFactor: release.uploadVolumeFactor,
  };
}

/**
 * A reduced view for an existing library file: its filename, size and parsed quality.
 * Language and indexer specs can't match here (metadata is gone), so formats that require
 * them never contribute — a conservative floor. Release-group and release-type specs CAN
 * match from the filename (the same way term specs do).
 */
export function existingFileMatchInput(existing: {
  relativePath: string;
  size: number;
  quality: Quality;
}): CustomFormatMatchInput {
  const basename = existing.relativePath.split(/[\\/]/).pop() ?? existing.relativePath;
  return {
    title: basename,
    size: existing.size,
    quality: existing.quality,
    languages: [],
    releaseGroup: parseReleaseGroup(basename) ?? undefined,
    releaseType: deriveReleaseType(basename),
  };
}

/** Derive a release's type (single/multi/season) from its title episode structure. */
function deriveReleaseType(title: string): ReleaseTypeValue | undefined {
  const ep = parseEpisodeRelease(title);
  if (ep.isSeasonPack) return "season";
  if (ep.isMultiEpisode) return "multi";
  if (ep.episodes.length > 0) return "single";
  return undefined;
}

function termMatches(spec: Extract<CustomFormatSpec, { type: "term" }>, input: CustomFormatMatchInput): boolean {
  const haystar = spec.caseSensitive ? input.title : input.title.toLowerCase();
  const term = spec.caseSensitive ? spec.term : spec.term.toLowerCase();
  let matched: boolean;
  if (spec.useRegex) {
    try {
      matched = new RegExp(term, spec.caseSensitive ? "" : "i").test(input.title);
    } catch {
      // A malformed user regex never matches rather than throwing at decision time.
      matched = false;
    }
  } else {
    matched = haystar.includes(term);
  }
  return spec.negate ? !matched : matched;
}

function sizeMatches(spec: Extract<CustomFormatSpec, { type: "size" }>, input: CustomFormatMatchInput): boolean {
  let matched = true;
  if (spec.min !== undefined && input.size < spec.min) matched = false;
  if (spec.max !== undefined && input.size > spec.max) matched = false;
  return spec.negate ? !matched : matched;
}

function languageMatches(spec: Extract<CustomFormatSpec, { type: "language" }>, input: CustomFormatMatchInput): boolean {
  const matched = input.languages.includes(spec.language);
  return spec.negate ? !matched : matched;
}

function indexerMatches(spec: Extract<CustomFormatSpec, { type: "indexer" }>, input: CustomFormatMatchInput): boolean {
  // undefined indexerId (existing file) never equals a concrete id: a non-negated spec
  // fails, a negated spec passes. Matches the conservative-floor rule in the header.
  const matched = input.indexerId !== undefined && input.indexerId === spec.indexerId;
  return spec.negate ? !matched : matched;
}

function resolutionMatches(spec: Extract<CustomFormatSpec, { type: "resolution" }>, input: CustomFormatMatchInput): boolean {
  const matched = input.quality.resolution === spec.resolution;
  return spec.negate ? !matched : matched;
}

function sourceMatches(spec: Extract<CustomFormatSpec, { type: "source" }>, input: CustomFormatMatchInput): boolean {
  const matched = input.quality.source === spec.source;
  return spec.negate ? !matched : matched;
}

function modifierMatches(spec: Extract<CustomFormatSpec, { type: "modifier" }>, input: CustomFormatMatchInput): boolean {
  const matched = (input.quality.modifier ?? "none") === spec.modifier;
  return spec.negate ? !matched : matched;
}

function releaseGroupMatches(spec: Extract<CustomFormatSpec, { type: "releaseGroup" }>, input: CustomFormatMatchInput): boolean {
  // undefined group (existing file with no parsed group, or unparseable title) never
  // equals a concrete group: non-negated fails, negated passes (conservative floor).
  if (input.releaseGroup === undefined) return spec.negate ? true : false;
  let matched: boolean;
  if (spec.useRegex) {
    // Upstream ReleaseGroupSpecification values are regex patterns (imports set useRegex).
    try {
      matched = new RegExp(spec.releaseGroup, spec.caseSensitive ? "" : "i").test(input.releaseGroup);
    } catch {
      matched = false;
    }
  } else {
    matched = spec.caseSensitive
      ? input.releaseGroup === spec.releaseGroup
      : input.releaseGroup.toLowerCase() === spec.releaseGroup.toLowerCase();
  }
  return spec.negate ? !matched : matched;
}

function releaseTypeMatches(spec: Extract<CustomFormatSpec, { type: "releaseType" }>, input: CustomFormatMatchInput): boolean {
  // A movie release (or a title that names no episode) has no release type. It must never
  // satisfy this spec — regardless of negate — the way upstream never exposes a Release
  // Type condition to a movie at all.
  if (input.releaseType === undefined) return false;
  const matched = input.releaseType === spec.releaseType;
  return spec.negate ? !matched : matched;
}

/**
 * Does a release's raw volume factors exhibit a given indexer flag? THE single home of the
 * threshold mapping (SON-025b) — `indexerFlagMatches` and the UI badge labels both call this,
 * so the values 0/.25/.5/.75 and the upload >1 rule can never drift between matcher and display.
 * An undefined factor never matches (existing files / releases without this data).
 */
export function releaseFlagMatches(rel: { downloadVolumeFactor?: number; uploadVolumeFactor?: number }, flag: IndexerFlagValue): boolean {
  switch (flag) {
    case "freeleech": return rel.downloadVolumeFactor !== undefined && rel.downloadVolumeFactor === 0;
    case "freeleech75": return rel.downloadVolumeFactor !== undefined && rel.downloadVolumeFactor === 0.25;
    case "halfleech": return rel.downloadVolumeFactor !== undefined && rel.downloadVolumeFactor === 0.5;
    case "freeleech25": return rel.downloadVolumeFactor !== undefined && rel.downloadVolumeFactor === 0.75;
    case "doubleUpload": return rel.uploadVolumeFactor !== undefined && rel.uploadVolumeFactor > 1;
    // internal/scene/nuked/subtitles carry no volume-factor signal — they are metadata-only bits
    // (set explicitly on a file via Manage Files), never derivable from a release's factors.
    case "internal":
    case "scene":
    case "nuked":
    case "subtitles": return false;
  }
}

/** Matches an indexerFlag spec against a release view, via the shared `releaseFlagMatches`
 *  threshold home (the web's badge mirrors those same thresholds locally). */
function indexerFlagMatches(spec: Extract<CustomFormatSpec, { type: "indexerFlag" }>, input: CustomFormatMatchInput): boolean {
  // Undefined factors (existing library file, or a release where the indexer exposed no
  // volume data) never match — non-negated fails, negated passes. Same conservative floor as
  // language/indexer specs.
  const matched = releaseFlagMatches(
    { downloadVolumeFactor: input.downloadVolumeFactor, uploadVolumeFactor: input.uploadVolumeFactor },
    spec.flag,
  );
  return spec.negate ? !matched : matched;
}

/** Whether a single spec passes for a given release view (negate already applied). */
export function matchSpec(spec: CustomFormatSpec, input: CustomFormatMatchInput): boolean {
  switch (spec.type) {
    case "term": return termMatches(spec, input);
    case "size": return sizeMatches(spec, input);
    case "language": return languageMatches(spec, input);
    case "indexer": return indexerMatches(spec, input);
    case "resolution": return resolutionMatches(spec, input);
    case "source": return sourceMatches(spec, input);
    case "modifier": return modifierMatches(spec, input);
    case "releaseGroup": return releaseGroupMatches(spec, input);
    case "releaseType": return releaseTypeMatches(spec, input);
    case "indexerFlag": return indexerFlagMatches(spec, input);
  }
}

/**
 * A format matches when every same-type GROUP's DidMatch is true, where a group's
 * DidMatch = !( any required member failed || all members failed ). See file header for
 * the full reasoning — this is SON-025's core fix over the old flat-AND.
 */
export function matchFormat(format: Pick<CustomFormat, "specs">, input: CustomFormatMatchInput): boolean {
  const groups = new Map<CustomFormatSpec["type"], CustomFormatSpec[]>();
  for (const spec of format.specs) {
    const arr = groups.get(spec.type);
    if (arr) arr.push(spec);
    else groups.set(spec.type, [spec]);
  }
  for (const specs of groups.values()) {
    if (!groupDidMatch(specs, input)) return false;
  }
  return true;
}

/** DidMatch formula for one same-type group. `spec.required !== false` treats an absent
 *  `required` key (a pre-required-backfill stored row) as required — preserving the
 *  legacy every-spec-must-pass behavior for those rows. */
function groupDidMatch(specs: CustomFormatSpec[], input: CustomFormatMatchInput): boolean {
  const results = specs.map((s) => matchSpec(s, input));
  const anyFailedRequired = specs.some((s, i) => s.required !== false && !results[i]);
  const allFailed = results.every((r) => !r);
  return !(anyFailedRequired || allFailed);
}

/**
 * Total format score for a release under a profile's per-format score map: the sum of
 * the scores of every matching format. `profileScores` maps custom-format id -> score;
 * a format absent from the map contributes 0 regardless of whether it matches.
 */
export function matchingFormats(
  formats: CustomFormat[],
  input: CustomFormatMatchInput,
): CustomFormat[] {
  return formats.filter((f) => matchFormat(f, input));
}

export function calculateFormatScore(
  formats: CustomFormat[],
  profileScores: Record<string, number>,
  input: CustomFormatMatchInput,
): number {
  let total = 0;
  for (const format of matchingFormats(formats, input)) {
    total += profileScores[format.id] ?? 0;
  }
  return total;
}

/** Convenience: normalize a possibly-undefined languages array. */
export function normalizeLanguages(languages: string[] | undefined): string[] {
  return languages ?? [];
}
