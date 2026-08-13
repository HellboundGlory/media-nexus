// SPDX-License-Identifier: MIT
import type { Release } from "./release";
import type { ReleaseTarget, ExistingFile } from "./media";
import { qualityAllowed, meetsCutoff, compareQuality, profilePosition, type QualityProfileLike } from "./quality";

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
 *  - Free space — gap report B8 (root folders / free space) is still open, so there
 *    is nothing to check a release's size against.
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
  | "blocklisted"
  | "queue_conflict"
  | "wrong_protocol";

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
}

export interface Decision {
  release: Release;
  approved: boolean;
  rejections: Rejection[];
  /** Carried through so `pickBest()` doesn't need a separate profile argument. */
  profile: QualityProfileLike | null;
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

/** Rejects when an existing file already meets the profile's cutoff (no further
 *  upgrades wanted) or when the release isn't actually better than what's already
 *  in the library. Looks at the best existing file among those the target covers —
 *  a deliberate simplification of upstream's per-episode granularity. */
const upgradeSpecification: Specification = (release, ctx) => {
  if (!ctx.profile) return null;
  if (ctx.existingFiles.length === 0) return null; // nothing to upgrade over — wanted/missing
  const best = ctx.existingFiles.reduce((a, b) => (compareQuality(b.quality, a.quality) > 0 ? b : a));
  if (meetsCutoff(ctx.profile, best.quality)) {
    return { reason: "cutoff_already_met", message: "the existing file already meets the quality cutoff" };
  }
  if (compareQuality(release.quality, best.quality) <= 0) {
    return { reason: "not_an_upgrade", message: "release is not a higher quality than the existing file" };
  }
  return null;
};

const blocklistSpecification: Specification = (_release, ctx) =>
  ctx.isBlocklisted ? { reason: "blocklisted", message: "this release has failed before and is blocklisted" } : null;

const queueConflictSpecification: Specification = (_release, ctx) =>
  ctx.hasActiveQueueConflict ? { reason: "queue_conflict", message: "already queued or downloading for this title" } : null;

const protocolSpecification: Specification = (release, ctx) => {
  if (ctx.preferredProtocol === "any") return null;
  if (release.protocol === ctx.preferredProtocol) return null;
  return { reason: "wrong_protocol", message: `preferred protocol is ${ctx.preferredProtocol}` };
};

/** Order only affects which rejection appears first when several specs reject the
 *  same release — every spec still runs, so `rejections` can carry more than one. */
export const SPECIFICATIONS: readonly Specification[] = [
  blocklistSpecification,
  queueConflictSpecification,
  profileAllowedSpecification,
  upgradeSpecification,
  protocolSpecification,
];

export function evaluate(release: Release, context: DecisionContext): Decision {
  const rejections = SPECIFICATIONS.map((spec) => spec(release, context)).filter((r): r is Rejection => r !== null);
  return { release, approved: rejections.length === 0, rejections, profile: context.profile };
}

/** Rank two *approved* decisions: profile order (or global quality if no profile
 *  was assigned) -> seeders -> freshness. Custom-format score and size proximity
 *  are documented slots for later (see file header), not built yet. */
export function compareDecisions(a: Decision, b: Decision): number {
  const qualityDiff = a.profile
    ? profilePosition(a.profile, a.release.quality) - profilePosition(a.profile, b.release.quality)
    : compareQuality(a.release.quality, b.release.quality);
  if (qualityDiff !== 0) return qualityDiff;
  const seedersDiff = (a.release.seeders ?? 0) - (b.release.seeders ?? 0);
  if (seedersDiff !== 0) return seedersDiff;
  return b.release.ageHours - a.release.ageHours; // newer (lower ageHours) wins
}

/** Best *approved* decision among a batch, or null if none were approved. */
export function pickBest(decisions: Decision[]): Decision | null {
  const approved = decisions.filter((d) => d.approved);
  if (approved.length === 0) return null;
  return [...approved].sort((a, b) => compareDecisions(b, a))[0];
}
