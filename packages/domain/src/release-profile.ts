// SPDX-License-Identifier: MIT
import { z } from "zod";

/**
 * Release profiles (roadmap P3, gap report C6): tag-scoped hard reject/require rules for the
 * decision engine, matching current upstream Sonarr `ReleaseProfile` + `ReleaseRestrictionsSpecification`
 * semantics — Required/Ignored term restrictions only, NO scored/"preferred" terms (Sonarr moved
 * scored term matching out of release profiles into Custom Formats via migration 171; this codebase
 * already ships the scored equivalent in custom-formats.ts, and Duplicating it here is deliberately
 * avoided).
 *
 * A profile's `required` terms are a hard "must contain at least one"; its `ignored` terms are a
 * hard "must not contain any". Terms use Sonarr `TermMatcherService` syntax: a term wrapped in
 * `/regex/` (optionally `/regex/flags`) is a case-insensitive-by-default regex, anything else is a
 * case-insensitive plain substring.
 *
 * Tag scoping: a profile applies to a target media item only when `tagApplies(profile.tags,
 * mediaTags)` (empty `tags` = applies to everything). This uses the codebase's single unified
 * tag-routing mechanism rather than upstream's separate indexer-id axis. That is a documented
 * deliberate simplification (the HANDOFF entry for this item records it as a "Superseded"-style
 * upstream divergence, matching how other deliberate divergences are noted). Pure, DB-free: the
 * API layer loads rows and hands them to the decision engine.
 */

export const releaseProfileSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  /** Must-contain-hard terms: a release must match at least one (per applicable profile). */
  required: z.array(z.string()).default([]),
  /** Must-not-contain terms: a release matching any of these is rejected. */
  ignored: z.array(z.string()).default([]),
  /** Media tag ids this profile applies to; empty = applies to all media. */
  tags: z.array(z.string()).default([]),
});
export type ReleaseProfileBody = z.infer<typeof releaseProfileSchema>;

/** Partial update; empty required/ignored arrays are meaningful (clearing terms), so a missing
 *  key (not present) is how you leave a field unchanged. */
export const updateReleaseProfileSchema = releaseProfileSchema.partial();
export type UpdateReleaseProfileBody = z.infer<typeof updateReleaseProfileSchema>;

/** The complete release profile as stored and evaluated. */
export interface ReleaseProfile {
  id: string;
  name: string;
  enabled: boolean;
  required: string[];
  ignored: string[];
  tags: string[];
}

/**
 * Sonarr `TermMatcherService` equivalent: a term wrapped in `/.../` is a regex (case-insensitive
 * unless the term supplies its own flags, e.g. `/foo/i` or `/foo/gi`); anything else is a
 * case-insensitive plain substring. A malformed user regex never matches (tolerant at decision
 * time, mirroring how custom-format terms are handled) rather than throwing.
 */
export function matchesTerm(term: string, title: string): boolean {
  const bracketed = /^\/(.+)\/([a-z]*)$/.exec(term);
  if (bracketed) {
    const [, pattern, flags] = bracketed;
    try {
      return new RegExp(pattern, flags.includes("i") ? flags : `${flags}i`).test(title);
    } catch {
      return false;
    }
  }
  return title.toLowerCase().includes(term.toLowerCase());
}
