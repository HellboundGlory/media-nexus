// SPDX-License-Identifier: MIT
import { z } from "zod";
import type { Release } from "./release";
import type { Quality } from "./quality";
import { parseLanguages } from "./parser";

/**
 * Custom-format matching and scoring (roadmap P2, gap report B4 remainder + D6).
 *
 * A custom format is a named collection of `specs`. Each spec tests one thing about
 * a parsed release — a title term/regex, a size range, a language, or the indexer it
 * came from. A format *matches* a release when every one of its specs passes
 * (respecting each spec's `negate`). Each quality profile then assigns the format an
 * integer score; a release's total `formatScore` for a profile is the sum of the
 * scores of every format that matches it.
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
 * is scored from a reduced view: title-term and size specs can match, but language
 * and indexer specs cannot (we no longer have that metadata) — a conservative floor.
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
    caseSensitive: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("size"),
    /** Inclusive lower bound in bytes. */
    min: z.number().nonnegative().optional(),
    /** Inclusive upper bound in bytes. */
    max: z.number().nonnegative().optional(),
    negate: z.boolean().default(false),
    caseSensitive: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("language"),
    /** ISO 639-1 / 639-2 code present on the release (e.g. "en", "fr", "de"). */
    language: z.string().min(1),
    negate: z.boolean().default(false),
    caseSensitive: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("indexer"),
    /** Indexer id the release must (or must not) have come from. */
    indexerId: z.string().min(1),
    negate: z.boolean().default(false),
    caseSensitive: z.boolean().default(false),
  }),
]);
export type CustomFormatSpec = z.infer<typeof customFormatSpecSchema>;

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
  };
}

/**
 * A reduced view for an existing library file: only its filename, size and parsed
 * quality. Language and indexer specs can't match here (metadata is gone), so formats
 * that require them never contribute — a conservative floor for existing files.
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
  };
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

/** Whether a single spec passes for a given release view. */
export function matchSpec(spec: CustomFormatSpec, input: CustomFormatMatchInput): boolean {
  switch (spec.type) {
    case "term": return termMatches(spec, input);
    case "size": return sizeMatches(spec, input);
    case "language": return languageMatches(spec, input);
    case "indexer": return indexerMatches(spec, input);
  }
}

/** A format matches when every spec passes. */
export function matchFormat(format: Pick<CustomFormat, "specs">, input: CustomFormatMatchInput): boolean {
  return format.specs.every((spec) => matchSpec(spec, input));
}

/**
 * Total format score for a release under a profile's per-format score map: the sum of
 * the scores of every matching format. `profileScores` maps custom-format id -> score;
 * a format absent from the map contributes 0 regardless of whether it matches.
 */
export function calculateFormatScore(
  formats: CustomFormat[],
  profileScores: Record<string, number>,
  input: CustomFormatMatchInput,
): number {
  let total = 0;
  for (const format of formats) {
    if (matchFormat(format, input)) {
      total += profileScores[format.id] ?? 0;
    }
  }
  return total;
}

/** Convenience: normalize a possibly-undefined languages array. */
export function normalizeLanguages(languages: string[] | undefined): string[] {
  return languages ?? [];
}
