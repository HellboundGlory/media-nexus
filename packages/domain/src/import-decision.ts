// SPDX-License-Identifier: MIT
import { compareQuality, meetsCutoff, type Quality, type QualityProfileLike } from "./quality";

/**
 * Per-file import decision (roadmap P0.5, gap report B2).
 *
 * Before this, import picked the single largest video file under a download's content
 * path and moved it — a season pack with 10 episode files imported 1 and silently lost
 * the other 9. This is the per-file counterpart to the release decision engine
 * (`decision.ts`, P0.3): given a file found inside a completed download, decide whether
 * it should be imported, and which episode(s) it covers.
 *
 * Deliberately narrow, matching what this project can actually check today:
 *  - Sample detection is filename-token based (`sample`), not upstream's duration/size
 *    heuristics — there is no media-info probing in this codebase yet.
 *  - "Still unpacking" is limited to empty files and known incomplete-transfer suffixes
 *    (`.part`, `.!ut`, `.crdownload`, `.incomplete`) — there's no archive-extraction
 *    awareness (no `.rar`/`.r00` handling).
 *  - The upgrade check reuses the *release's* quality (parsed once at grab time, the same
 *    way `spQuality()` already works) for every file in the download, since one grab is
 *    one release with one quality — not a per-file media-info probe. This is where P0.2's
 *    `upgradeSpecification` comment ("a deliberate simplification... per-episode
 *    granularity") gets its per-episode granularity: each matched episode's *own* existing
 *    file is checked individually, not just the target's single best existing file.
 */

export interface ImportCandidateFile {
  path: string;
  size: number;
}

export type ImportRejectionReason =
  | "sample"
  | "incomplete_transfer"
  | "no_matching_episode"
  | "cutoff_already_met"
  | "not_an_upgrade"
  // Manage Files/Episodes only (MANAGEFILES-1): a tracked file whose quality sits below the
  // title's profile cutoff. Reuses the same ImportRejection wire shape as the import reasons.
  | "below_cutoff";

export interface ImportRejection {
  reason: ImportRejectionReason;
  message: string;
}

export interface ImportFileDecision {
  file: ImportCandidateFile;
  /** Episode ids this file was matched to (empty if none, or not an episode file). */
  episodeIds: string[];
  approved: boolean;
  rejections: ImportRejection[];
}

/** What a season's episode looks like for import matching: its id and, if one already
 *  exists, the best quality already on file for it (input to the upgrade check). */
export interface KnownEpisode {
  id: string;
  existingQuality: Quality | null;
}

const SAMPLE_RE = /(?:^|[._\s-])sample(?:[._\s-]|$)/i;
const INCOMPLETE_SUFFIXES = [".part", ".!ut", ".crdownload", ".incomplete"];

function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Checks every path segment, not just the filename — release groups commonly put
 *  samples in a "Sample" subfolder rather than naming the file itself. */
export function isSample(path: string): boolean {
  return path.split(/[\\/]/).some((segment) => SAMPLE_RE.test(segment));
}

export function isIncompleteTransfer(file: ImportCandidateFile): boolean {
  if (file.size <= 0) return true;
  const name = fileName(file.path).toLowerCase();
  return INCOMPLETE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * Decide one file found inside a completed download.
 *
 * @param episodesInFile Episode number(s) parsed from the file's own name (or the
 *   release title, for a single-file download where the filename itself is uninformative
 *   — the caller resolves which to use).
 * @param knownEpisodes Episode number -> `KnownEpisode` for every episode of the target
 *   season (from `MediaRepository.episodesInSeason()`/`episodesByNumber()`).
 * @param releaseQuality The grabbed release's quality (one release, one quality, for
 *   every file in the download — see file header).
 * @param profile The target's assigned quality profile, or null if none (unrestricted,
 *   matching `decision.ts`'s convention).
 */
export function decideImportFile(
  file: ImportCandidateFile,
  episodesInFile: number[],
  knownEpisodes: Map<number, KnownEpisode>,
  releaseQuality: Quality,
  profile: QualityProfileLike | null,
): ImportFileDecision {
  const rejections: ImportRejection[] = [];

  if (isSample(file.path)) {
    rejections.push({ reason: "sample", message: "looks like a sample file" });
  }
  if (isIncompleteTransfer(file)) {
    rejections.push({ reason: "incomplete_transfer", message: "file is empty or still being written" });
  }

  const matched = episodesInFile
    .map((n) => knownEpisodes.get(n))
    .filter((e): e is KnownEpisode => e !== undefined);
  const episodeIds = matched.map((e) => e.id);

  if (episodesInFile.length > 0 && matched.length === 0) {
    rejections.push({ reason: "no_matching_episode", message: "file's episode number doesn't match any episode of this season" });
  }

  if (rejections.length === 0 && profile && matched.length > 0) {
    const withExisting = matched.filter((e): e is KnownEpisode & { existingQuality: Quality } => e.existingQuality !== null);
    if (withExisting.length === matched.length) {
      // every matched episode already has a file — only reject if none of them would
      // actually be improved by this one.
      if (withExisting.every((e) => meetsCutoff(profile, e.existingQuality))) {
        rejections.push({ reason: "cutoff_already_met", message: "every matched episode already meets the quality cutoff" });
      } else if (withExisting.every((e) => compareQuality(releaseQuality, e.existingQuality) <= 0)) {
        rejections.push({ reason: "not_an_upgrade", message: "release is not a higher quality than the existing file(s)" });
      }
    }
    // else: at least one matched episode has no existing file at all — approved as a
    // wanted/missing fill-in, same as decision.ts's upgradeSpecification when
    // existingFiles is empty.
  }

  return { file, episodeIds, approved: rejections.length === 0, rejections };
}
