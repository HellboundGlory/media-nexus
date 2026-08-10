// SPDX-License-Identifier: MIT
import type { Quality } from "./quality";
import { parseQualityFromTitle, parseYear } from "./parser";

/**
 * Episode release parsing + series/episode matching (M2).
 * Handles the common release layouts: `Show.S05E16.1080p.WEB-DL`,
 * multi-episode `Show.S05E16-E17.720p`, `Show.S05E16E17`, and "Season 5 - Episode 16".
 * Scene/absolute numbering (anime) is flagged as a follow-up.
 */

export interface EpisodeReleaseMatch {
  /** best-guess series title (normalized, lowercase, tokens joined by space) */
  seriesTitle?: string;
  season?: number;
  /** one or more episode numbers this release contains */
  episodes: number[];
  isMultiEpisode: boolean;
  quality: Quality;
  year?: number;
  /** 0..1 heuristic confidence that this is really an episode release */
  confidence: number;
}

const SXXEXX = /S(\d{1,2})E(\d{1,3})(?:-E?(\d{1,3})|E(\d{1,3})|-(\d{1,3}))?/i;
const MULTI_SXXEXX = /S(\d{1,2})E(\d{1,3})[.,-]?E(\d{1,3})/i;
const SEASON_EPISODE = /Season\s*(\d{1,2})[\s,-]*(?:Episode|EP|E)\s*(\d{1,3})/i;

/** Tokens that terminate the series-name portion of an episode title. */
const TITLE_STOP_PATTERNS = [
  /S\d{1,2}E\d{1,3}/i,
  /Season\s*\d{1,2}/i,
  /\b(?:1080p|720p|2160p|480p|576p)\b/i,
  /\b(?:Blu-?Ray|WEB-?DL|WEBRip|WEB|HDTV|BDRip|BRRip|DVDRip|REMUX|HDR|DV)\b/i,
];

export function parseEpisodeRelease(title: string): EpisodeReleaseMatch {
  const sxx = SXXEXX.exec(title);
  if (sxx) {
    const season = Number(sxx[1]);
    const first = Number(sxx[2]);
    const second = sxx[3] || sxx[4] || sxx[5];
    const episodes = second ? uniqueSorted([first, Number(second)]) : [first];
    return {
      season,
      episodes,
      isMultiEpisode: episodes.length > 1,
      seriesTitle: extractSeriesTitle(title, sxx.index),
      quality: parseQualityFromTitle(title),
      year: parseYear(title),
      confidence: 1,
    };
  }

  const se = SEASON_EPISODE.exec(title);
  if (se) {
    return {
      season: Number(se[1]),
      episodes: [Number(se[2])],
      isMultiEpisode: false,
      seriesTitle: extractSeriesTitle(title, se.index),
      quality: parseQualityFromTitle(title),
      year: parseYear(title),
      confidence: 1,
    };
  }

  // no explicit numbers — could be a season pack or non-episodic; low confidence
  return {
    seriesTitle: extractSeriesTitle(title, -1),
    episodes: [],
    isMultiEpisode: false,
    quality: parseQualityFromTitle(title),
    year: parseYear(title),
    confidence: 0,
  };
}

/** Normalize a title for matching: dots/underscores/spaces -> single spaces, lowercase. */
export function normalizeReleaseSeriesName(s: string): string {
  return s
    .replace(/[._[\]()!?'-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function stripThe(s: string): string {
  return s.replace(/^the\s+/, "");
}

/** Whether a parsed release series-name plausibly matches a library series title. */
export function seriesTitleMatches(releaseName: string | undefined, libraryTitle: string): boolean {
  if (!releaseName) return false;
  const r = normalizeReleaseSeriesName(releaseName);
  const t = normalizeReleaseSeriesName(libraryTitle);
  if (!r || !t) return false;
  const r2 = stripThe(r);
  const t2 = stripThe(t);
  const squash = (s: string) => s.replace(/\s+/g, "");
  return r === t
    || r2 === t2
    || squash(r) === squash(t)
    || r.includes(t)
    || t.includes(r)
    || (r2.length >= 3 && t2.length >= 3 && (r2.startsWith(t2) || t2.startsWith(r2)));
}

/** The "up to the title terminator" token sequence, as a cleaned string. */
function extractSeriesTitle(title: string, stopIndex: number): string | undefined {
  let head = stopIndex >= 0 ? title.slice(0, stopIndex) : title;
  const stop = TITLE_STOP_PATTERNS.map((re) => re.exec(head)).filter(Boolean).reduce<number | null>(
    (acc, m) => (acc === null || m!.index < acc ? m!.index : acc),
    null,
  );
  if (stop !== null) head = head.slice(0, stop);
  const cleaned = head.replace(/[._[\]()!?'":]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || undefined;
}

function uniqueSorted(nums: number[]): number[] {
  return [...new Set(nums)].sort((a, b) => a - b);
}

export { MULTI_SXXEXX };

/** Standard scene query tag, e.g. S05E16 — used when searching indexers for an episode. */
export function episodeQueryTag(season: number, episode: number): string {
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}
