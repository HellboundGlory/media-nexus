// SPDX-License-Identifier: MIT
import type { CustomFormatSpec, ReleaseTypeValue } from "./custom-formats";
import type { QualityModifier, QualitySource, Resolution } from "./quality";

/**
 * Custom-format import/export (SON-025 Phase 4, gap finding UNI-025; served on the native
 * API and reused unchanged by the Sonarr/Radarr compat surface, UNI-026).
 *
 * Maps between MediaNexus' internal `CustomFormatSpec` shape and the upstream Sonarr/Radarr
 * `CustomFormatResource` wire shape:
 *
 *   { name, includeCustomFormatWhenRenaming: bool,
 *     specifications: [{ name, implementation, negate, required,
 *                        fields: { value|min|max|regex ... } }] }
 *
 * The `implementation` string (e.g. "ReleaseTitleSpecification") is the upstream REST /
 * UI-Import contract — it's how community format packs (Dictionarry/Dumpstarr, TRaSH guides)
 * are distributed and consumed. Keeping the mapper here means the native import/export and
 * the compat `/customformat` REST API share one implementation (no divergent logic).
 *
 * `includeCustomFormatWhenRenaming` is accepted-and-ignored on import (MediaNexus has no
 * naming-template token for it yet — a separate, smaller gap, deliberately not in scope).
 *
 * Unsupported `implementation`s (IndexerFlag/Edition/Year, and modifier values we don't
 * model) are NOT silently dropped or fatal: they're reported per-condition in the result so
 * the caller can surface "N conditions imported, M skipped (with reason)".
 */

export interface UpstreamCustomFormatSpec {
  name?: string;
  implementation: string;
  negate?: boolean;
  required?: boolean;
  fields?: Record<string, unknown>;
}

export interface UpstreamCustomFormat {
  name: string;
  includeCustomFormatWhenRenaming?: boolean;
  specifications: UpstreamCustomFormatSpec[];
}

/** A condition we couldn't import, with the reason (never silently dropped). */
export interface ImportSkip {
  implementation: string;
  reason: string;
}

export interface ImportResult {
  name: string;
  specs: CustomFormatSpec[];
  skipped: ImportSkip[];
}

/** The upstream `implementation` strings we map (informs GET /customformat/schema). */
export const SUPPORTED_IMPLEMENTATIONS = [
  "ReleaseTitleSpecification",
  "SizeSpecification",
  "LanguageSpecification",
  "SourceSpecification",
  "ResolutionSpecification",
  "QualityModifierSpecification",
  "ReleaseGroupSpecification",
  "ReleaseTypeSpecification",
] as const;

// --- Upstream enum mappers (values are facts from upstream QualitySource/Resolution/
// ReleaseType/QualityModifier .cs enums, NOT guesses). ---
const UPSTREAM_SOURCE: Record<QualitySource, number> = {
  unknown: 0, sd: 2, dvd: 5, hdtv: 6, web: 7, webdl: 7, webrip: 8, bluray: 9,
};
const SOURCE_FROM_VALUE: Record<number, QualitySource> = {
  0: "unknown", 1: "sd", 2: "sd", 5: "dvd", 6: "hdtv", 7: "webdl", 8: "webrip", 9: "bluray",
};

const UPSTREAM_RESOLUTION: Record<Resolution, number> = {
  // Upstream (Radarr/Sonarr `Quality.cs`) uses the LITERAL PIXEL HEIGHT as the value
  // (`Bluray2160p => new Quality(..., 2160)`), not a sequential index. unknown=0.
  unknown: 0, "480p": 480, "576p": 576, "720p": 720, "1080p": 1080, "2160p": 2160,
};
const RESOLUTION_FROM_VALUE: Record<number, Resolution> = {
  0: "unknown", 480: "480p", 576: "576p", 720: "720p", 1080: "1080p", 2160: "2160p",
};

const UPSTREAM_RELEASE_TYPE: Record<ReleaseTypeValue, number> = { single: 1, multi: 2, season: 3 };
const RELEASE_TYPE_FROM_VALUE: Record<number, ReleaseTypeValue> = { 1: "single", 2: "multi", 3: "season" };

// Upstream QualityModifier enum: NONE=0, REGIONAL=1, SCREENER=2, RAWHD=3, BRDISK=4, REMUX=5.
// We model only none/brdisk/remux (RAD-010 deliberate scope) — the others are skipped on import.
const UPSTREAM_MODIFIER: Record<QualityModifier, number> = { none: 0, brdisk: 4, remux: 5 };
const MODIFIER_FROM_VALUE: Record<number, QualityModifier> = { 0: "none", 4: "brdisk", 5: "remux" };

type PartialSpec = CustomFormatSpec & { required?: boolean };

/** Serialize our internal format to the upstream wire shape. */
export function customFormatToUpstream(specs: CustomFormatSpec[]): UpstreamCustomFormatSpec[] {
  return specs.map((spec): UpstreamCustomFormatSpec => {
    const base = { negate: !!spec.negate, required: spec.required !== false };
    switch (spec.type) {
      case "term":
        // Upstream's ReleaseTitleSpecification has only a `value` field (the regex string);
        // NO `regex` boolean exists upstream — every condition is unconditionally a regex
        // there. We export just `value` regardless of our plain/regex internal mode (a plain
        // substring round-trips acceptably for typical alphanumeric terms; see import).
        return { ...base, implementation: "ReleaseTitleSpecification", fields: { value: spec.term } };
      case "size":
        return { ...base, implementation: "SizeSpecification", fields: { min: spec.min, max: spec.max } };
      case "language":
        return { ...base, implementation: "LanguageSpecification", fields: { value: spec.language } };
      case "source":
        return { ...base, implementation: "SourceSpecification", fields: { value: UPSTREAM_SOURCE[spec.source] } };
      case "resolution":
        return { ...base, implementation: "ResolutionSpecification", fields: { value: UPSTREAM_RESOLUTION[spec.resolution] } };
      case "modifier":
        return { ...base, implementation: "QualityModifierSpecification", fields: { value: UPSTREAM_MODIFIER[spec.modifier] } };
      case "releaseGroup":
        // Upstream's ReleaseGroupSpecification value is a regex pattern; export it as-is.
        return { ...base, implementation: "ReleaseGroupSpecification", fields: { value: spec.releaseGroup } };
      case "releaseType":
        return { ...base, implementation: "ReleaseTypeSpecification", fields: { value: UPSTREAM_RELEASE_TYPE[spec.releaseType] } };
      case "indexer":
        // MediaNexus-only condition; no upstream equivalent — surfaced on export as-is and
        // dropped (with a reason) if that export is ever re-imported elsewhere.
        return { ...base, implementation: "__MediaNexusIndexerSpecification__", fields: { value: spec.indexerId } };
    }
  });
}

/** Map one upstream specification into our internal spec (plus any skip reason). */
export function upstreamSpecToCustom(spec: UpstreamCustomFormatSpec): { spec?: PartialSpec; skip?: ImportSkip } {
  const req = spec.required !== false; // upstream spec absent-required behaves like ours
  const fields = spec.fields ?? {};
  switch (spec.implementation) {
    case "ReleaseTitleSpecification":
      // Upstream's ReleaseTitleSpecification (extends RegexSpecificationBase) ALWAYS compiles
      // `fields.value` as a regex — there is no plain-substring mode upstream at all. So we
      // unconditionally map imports to `useRegex: true`.
      return { spec: { type: "term", term: String(fields.value ?? ""), useRegex: true, negate: !!spec.negate, required: req } };
    case "SizeSpecification": {
      const min = typeof fields.min === "number" ? fields.min : undefined;
      const max = typeof fields.max === "number" ? fields.max : undefined;
      return { spec: { type: "size", min, max, negate: !!spec.negate, required: req } };
    }
    case "LanguageSpecification":
      return { spec: { type: "language", language: String(fields.value ?? ""), negate: !!spec.negate, required: req } };
    case "SourceSpecification": {
      const source = SOURCE_FROM_VALUE[Number(fields.value)];
      if (!source) return { skip: { implementation: spec.implementation, reason: `unknown source value ${fields.value}` } };
      return { spec: { type: "source", source, negate: !!spec.negate, required: req } };
    }
    case "ResolutionSpecification": {
      const resolution = RESOLUTION_FROM_VALUE[Number(fields.value)];
      if (!resolution) return { skip: { implementation: spec.implementation, reason: `unknown resolution value ${fields.value}` } };
      return { spec: { type: "resolution", resolution, negate: !!spec.negate, required: req } };
    }
    case "QualityModifierSpecification": {
      const modifier = MODIFIER_FROM_VALUE[Number(fields.value)];
      if (!modifier) return { skip: { implementation: spec.implementation, reason: `unsupported quality modifier value ${fields.value} (we model none/brdisk/remux only)` } };
      return { spec: { type: "modifier", modifier, negate: !!spec.negate, required: req } };
    }
    case "ReleaseGroupSpecification":
      // Upstream's ReleaseGroupSpecification value is ALWAYS a regex pattern (extends
      // RegexSpecificationBase) — map to useRegex:true on import so the stored condition
      // matches via regex against the parsed release-group token, not literal string equality.
      return { spec: { type: "releaseGroup", releaseGroup: String(fields.value ?? ""), useRegex: true, negate: !!spec.negate, required: req } };
    case "ReleaseTypeSpecification": {
      const releaseType = RELEASE_TYPE_FROM_VALUE[Number(fields.value)];
      if (!releaseType) return { skip: { implementation: spec.implementation, reason: `unknown release type value ${fields.value}` } };
      return { spec: { type: "releaseType", releaseType, negate: !!spec.negate, required: req } };
    }
    default:
      return { skip: { implementation: spec.implementation, reason: `unsupported implementation '${spec.implementation}'` } };
  }
}

/** Full upstream -> internal import: valid specs + clear per-condition skips. */
export function upstreamToCustomFormat(body: UpstreamCustomFormat): ImportResult {
  const specs: CustomFormatSpec[] = [];
  const skipped: ImportSkip[] = [];
  for (const spec of body.specifications ?? []) {
    const mapped = upstreamSpecToCustom(spec);
    if (mapped.skip) skipped.push({ ...mapped.skip, implementation: spec.implementation });
    else if (mapped.spec) specs.push(mapped.spec as CustomFormatSpec);
  }
  return { name: body.name, specs, skipped };
}
