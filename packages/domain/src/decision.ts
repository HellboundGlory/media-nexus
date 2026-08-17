// SPDX-License-Identifier: MIT
import type { Release } from "./release";
import type { ReleaseTarget, ExistingFile } from "./media";
import { qualityAllowed, meetsCutoff, compareQuality, profilePosition, type QualityProfileLike } from "./quality";
import {
  calculateFormatScore, matchingFormats, releaseMatchInput, existingFileMatchInput, type CustomFormat,
} from "./custom-formats";
import { tagApplies } from "./tags";
import { matchesTerm, type ReleaseProfile } from "./release-profile";

/**
 * Release decision engine (roadmap P0.3, gap report B1).
 *
 * Before this, nothing evaluated whether a release should be grabbed — grab was
 * unconditional: `IndexersService.grab()` added any release to a client, and
 * `RssSyncService.bestRelease()` sorted by quality then seeders and grabbed the top
 * result. Automation could grab a 480p cam over an existing 1080p file, re-grab a
 * release already known to fail, and grab two releases for the same episode.
 *
 * Specifications are pure functions over `(release, context)`. The movie/series
 * difference lives only in how `DecisionContext` is assembled (see
 * `apps/api/src/decision/decision.service.ts`), never inside a specification — no
 * spec here branches on media type.
 *
 * Deliberately NOT built here (see the P0.2/P0.4 handoffs this depends on, and the
 * gap report's own scoping):
 *  - Per-quality size limits — `quality_definition` (P0.2) stores min/max per
 *    runtime-minute, but no runtime is modelled on movie/episode rows yet.
 *  - Custom-format scoring (roadmap P2) — the comparator has a documented slot.
 *  - Minimum-age / retention delay — no settings exist to configure either, and
 *    adding them is a product decision beyond "wire up what's already there."
 * Age and seeders are used as **comparator** tiebreakers instead of hard-reject
 * specs, matching the gap report's own description of the comparator: "profile
 * order -> custom-format score -> protocol preference -> age/seeders -> size
 * proximity" lists age/seeders as ranking input, not a rejection.
 */

export type RejectionReason =
  | "unresolved_target"
  | "not_allowed_by_profile"
  | "cutoff_already_met"
  | "not_an_upgrade"
  | "below_min_format_score"
  | "blocklisted"
  | "queue_conflict"
  | "wrong_protocol"
  | "insufficient_free_space"
  | "required_term_missing"
  | "ignored_term_present";

export interface Rejection {
  reason: RejectionReason;
  message: string;
}

/** Everything a specification needs, assembled once per (release, target media) by
 *  the API layer — this file stays pure domain code with no DB access. */
export interface DecisionContext {
  target: ReleaseTarget;
  profile: QualityProfileLike | null;
  existingFiles: ExistingFile[];
  isBlocklisted: boolean;
  hasActiveQueueConflict: boolean;
  preferredProtocol: "usenet" | "torrent" | "any";
  /** Free bytes on the target root folder's filesystem, or null when it couldn't be
   *  determined (root folder not yet configured/accessible) — null never blocks a grab,
   *  matching the permissive default every other unknown-state case in this file uses. */
  freeSpaceBytes: number | null;
  /** `media.minimumFreeSpaceMb` setting — the safety margin required to remain *after*
   *  the release downloads (roadmap P1, gap report B8). */
  minimumFreeSpaceMb: number;
  /** Custom formats to score releases/existing files against (roadmap P2). Optional so
   *  callers that don't configure formats (and pre-existing tests) stay valid: an empty
   *  list makes every format score 0 and format behavior inert. */
  customFormats?: CustomFormat[];
  /** Per-format scores for the assigned profile, keyed by custom format id. */
  formatScores?: Record<string, number>;
  /** Grab-side threshold — a release scoring below this is rejected. 0 disables. */
  minFormatScore?: number;
  /** Upgrade-side cutoff — once an existing file reaches this format score (and the
   *  quality cutoff), no further upgrades are wanted. 0 disables. */
  cutoffFormatScore?: number;
  /** Enabled release profiles to apply as hard required/ignored term restrictions (roadmap P3,
   *  gap C6). Optional so callers that don't configure profiles stay valid: an empty list makes
   *  release-profile restrictions inert. All *enabled* profiles, unfiltered — each spec calls
   *  `tagApplies(profile.tags, mediaTags)` before checking terms, so enabled-but-non-applicable
   *  profiles are a no-op rather than a filter here. */
  releaseProfiles?: ReleaseProfile[];
  /** The target media item's own tag ids, used to decide which release profiles apply. */
  mediaTags?: string[];
}

/** Score a release against the profile's formats; 0 when none are configured. */
export function releaseFormatScore(release: Release, ctx: DecisionContext): number {
  return calculateFormatScore(ctx.customFormats ?? [], ctx.formatScores ?? {}, releaseMatchInput(release));
}

/** Score an existing library file (conservative floor — see custom-formats.ts header). */
function existingFormatScore(file: ExistingFile, ctx: DecisionContext): number {
  return calculateFormatScore(ctx.customFormats ?? [], ctx.formatScores ?? {}, existingFileMatchInput(file));
}

export interface Decision {
  release: Release;
  approved: boolean;
  rejections: Rejection[];
  /** Carried through so `pickBest()` doesn't need a separate profile argument. */
  profile: QualityProfileLike | null;
  /** Total custom-format score of the release under the profile's scores (0 if none
   *  configured). Used as the tiebreaker after quality and by the upgrade check. */
  formatScore: number;
  /** The subset of custom formats that matched this release (id + name only, for UI). */
  matchedFormats: { id: string; name: string }[];
}

export type Specification = (release: Release, context: DecisionContext) => Rejection | null;

const profileAllowedSpecification: Specification = (release, ctx) => {
  if (!ctx.profile) return null; // no profile assigned: unrestricted, matches today's behaviour
  if (qualityAllowed(ctx.profile, release.quality)) return null;
  return {
    reason: "not_allowed_by_profile",
    message: `${release.quality.source}/${release.quality.resolution} isn't allowed by the assigned quality profile`,
  };
};

/** Rejects when an existing file already meets the profile's quality AND format cutoff
 *  (no further upgrades wanted) or when the release isn't actually better than what's
 *  already in the library — on quality OR custom-format score. Looks at the best existing
 *  file among those the target covers — a deliberate simplification of upstream's
 *  per-episode granularity.
 *
 *  Custom-format scoring (roadmap P2) makes a same-or-lower quality release eligible for
 *  upgrade when its format score beats the held file's, gated by `cutoffFormatScore` the
 *  same way the quality cutoff gates quality upgrades. */
const upgradeSpecification: Specification = (release, ctx) => {
  if (!ctx.profile) return null;
  if (ctx.existingFiles.length === 0) return null; // nothing to upgrade over — wanted/missing
  const best = ctx.existingFiles.reduce((a, b) => (compareQuality(b.quality, a.quality) > 0 ? b : a));
  const bestScore = existingFormatScore(best, ctx);
  const cutoffFormatScore = ctx.cutoffFormatScore ?? 0;
  if (meetsCutoff(ctx.profile, best.quality) && bestScore >= cutoffFormatScore) {
    return { reason: "cutoff_already_met", message: "the existing file already meets the quality and format cutoff" };
  }
  const qualityBetter = compareQuality(release.quality, best.quality) > 0;
  const formatBetter = releaseFormatScore(release, ctx) > bestScore;
  if (!qualityBetter && !formatBetter) {
    return { reason: "not_an_upgrade", message: "release is not a higher quality or format score than the existing file" };
  }
  return null;
};

/** Rejects releases whose custom-format score falls below the profile's `minFormatScore`.
 *  0 (the default) disables the gate entirely. */
const minFormatScoreSpecification: Specification = (release, ctx) => {
  const min = ctx.minFormatScore ?? 0;
  if (min <= 0) return null;
  const score = releaseFormatScore(release, ctx);
  if (score < min) {
    return {
      reason: "below_min_format_score",
      message: `release format score ${score} is below the profile's minimum of ${min}`,
    };
  }
  return null;
};

const blocklistSpecification: Specification = (_release, ctx) =>
  ctx.isBlocklisted ? { reason: "blocklisted", message: "this release has failed before and is blocklisted" } : null;

const queueConflictSpecification: Specification = (_release, ctx) =>
  ctx.hasActiveQueueConflict ? { reason: "queue_conflict", message: "already queued or downloading for this title" } : null;

/** Hard required/ignored term restrictions from tag-applicable release profiles (roadmap P3,
 *  gap C6). Mirrors upstream `ReleaseRestrictionsSpecification`: every enabled profile that
 *  applies to this media's tags is checked independently — a release must satisfy EACH applicable
 *  profile (must match at least one of its `required` terms and none of its `ignored` terms), so a
 *  release rejected by one applicable profile is rejected even if another profile would accept it.
 *  Reject-only: scored/"preferred" terms are Custom Formats' job (see release-profile.ts header). */
const releaseProfileSpecification: Specification = (release, ctx) => {
  const profiles = ctx.releaseProfiles ?? [];
  for (const profile of profiles) {
    if (!tagApplies(profile.tags, ctx.mediaTags)) continue; // profile not scoped to this media
    if (profile.required.length > 0 && !profile.required.some((term) => matchesTerm(term, release.title))) {
      return {
        reason: "required_term_missing",
        message: `release doesn't match any required term of profile "${profile.name}"`,
      };
    }
    const hit = profile.ignored.find((term) => matchesTerm(term, release.title));
    if (hit) {
      return {
        reason: "ignored_term_present",
        message: `release matches ignored term "${hit}" of profile "${profile.name}"`,
      };
    }
  }
  return null;
};

const protocolSpecification: Specification = (release, ctx) => {
  if (ctx.preferredProtocol === "any") return null;
  if (release.protocol === ctx.preferredProtocol) return null;
  return { reason: "wrong_protocol", message: `preferred protocol is ${ctx.preferredProtocol}` };
};

/** Rejects when downloading this release would leave the target root folder's filesystem
 *  below the configured safety margin. `freeSpaceBytes === null` (root folder missing or
 *  unreadable) never blocks — that state is surfaced elsewhere (health checks, gap report
 *  B9, not yet built) rather than silently stalling every grab. */
const freeSpaceSpecification: Specification = (release, ctx) => {
  if (ctx.freeSpaceBytes === null) return null;
  const marginBytes = ctx.minimumFreeSpaceMb * 1024 * 1024;
  if (ctx.freeSpaceBytes - release.size >= marginBytes) return null;
  return {
    reason: "insufficient_free_space",
    message: `downloading this release would leave less than the configured ${ctx.minimumFreeSpaceMb}MB free on the target root folder`,
  };
};

/** Order only affects which rejection appears first when several specs reject the
 *  same release — every spec still runs, so `rejections` can carry more than one. */
export const SPECIFICATIONS: readonly Specification[] = [
  blocklistSpecification,
  queueConflictSpecification,
  profileAllowedSpecification,
  minFormatScoreSpecification,
  releaseProfileSpecification,
  upgradeSpecification,
  protocolSpecification,
  freeSpaceSpecification,
];

export function evaluate(release: Release, context: DecisionContext): Decision {
  const formatScore = releaseFormatScore(release, context);
  const matchedFormats = matchingFormats(context.customFormats ?? [], releaseMatchInput(release)).map((f) => ({ id: f.id, name: f.name }));
  const rejections = SPECIFICATIONS.map((spec) => spec(release, context)).filter((r): r is Rejection => r !== null);
  return { release, approved: rejections.length === 0, rejections, profile: context.profile, formatScore, matchedFormats };
}

/** Rank two *approved* decisions: profile order (or global quality if no profile was
 *  assigned) -> custom-format score -> seeders -> indexer priority -> freshness. Size
 *  proximity is a documented later slot (see file header). Indexer priority (roadmap J7)
 *  breaks a seeders tie: when every higher-ranked criterion is equal, prefer the release
 *  from the higher-priority indexer. Sonarr/Prowlarr priority is a number where LOWER =
 *  HIGHER priority (1 best, 50 worst; schema default 25), so compareDecisions returns
 *  b - a on indexerPriority to make the lower number win. */
export function compareDecisions(a: Decision, b: Decision): number {
  const qualityDiff = a.profile
    ? profilePosition(a.profile, a.release.quality) - profilePosition(a.profile, b.release.quality)
    : compareQuality(a.release.quality, b.release.quality);
  if (qualityDiff !== 0) return qualityDiff;
  const formatDiff = a.formatScore - b.formatScore;
  if (formatDiff !== 0) return formatDiff;
  const seedersDiff = (a.release.seeders ?? 0) - (b.release.seeders ?? 0);
  if (seedersDiff !== 0) return seedersDiff;
  // Indexer priority (roadmap J7) breaks a seeders tie: when every higher-ranked criterion
  // is equal, prefer the release from the higher-priority indexer. Upstream (Sonarr/Prowlarr)
  // convention — LOWER number = HIGHER priority (1 best, 50 worst; schema default 25) — so
  // return b - a to make the lower number win.
  const indexerDiff = (b.release.indexerPriority ?? 25) - (a.release.indexerPriority ?? 25);
  if (indexerDiff !== 0) return indexerDiff;
  return b.release.ageHours - a.release.ageHours; // newer (lower ageHours) wins
}

/** Best *approved* decision among a batch, or null if none were approved. */
export function pickBest(decisions: Decision[]): Decision | null {
  const approved = decisions.filter((d) => d.approved);
  if (approved.length === 0) return null;
  return [...approved].sort((a, b) => compareDecisions(b, a))[0];
}
