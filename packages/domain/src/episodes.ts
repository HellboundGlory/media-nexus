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
  /** the release names a season but no episodes — it covers the whole season */
  isSeasonPack: boolean;
  /**
   * Daily/date-based numbering (seriesType "daily"): the air date a release names,
   * "YYYY-MM-DD". Only set when a full month+day is present — a bare year never counts
   * (it would misclassify every "%Y.1080p" movie release as an episode). The matching
   * layer resolves this against `episode.airDateUtc`.
   */
  dailyDate?: string;
  /**
   * Absolute/anime numbering (seriesType "anime"): a lone numeric episode token in the
   * title, resolved against `episode.absoluteNumber` across all seasons. Never a
   * resolution tag (480/576/720/1080/2160/4320) and never a 4-digit year.
   */
  absoluteNumber?: number;
  /** Speculative absolute guess (lowered confidence) — matching layer prefers a confident
   *  S&E match over this when both are present. */
  absoluteIsGuess?: boolean;
  quality: Quality;
  year?: number;
  /** 0..1 heuristic confidence that this is really an episode release */
  confidence: number;
}

const SXXEXX = /S(\d{1,2})E(\d{1,3})(?:-E?(\d{1,3})|E(\d{1,3})|-(\d{1,3}))?/i;
const MULTI_SXXEXX = /S(\d{1,2})E(\d{1,3})[.,-]?E(\d{1,3})/i;
const SEASON_EPISODE = /Season\s*(\d{1,2})[\s,-]*(?:Episode|EP|E)\s*(\d{1,3})/i;
/**
 * Season-pack forms: "Show.S02.1080p", "Show Season 2 COMPLETE", "Show.Complete.Season.2".
 * The negative lookahead keeps this from firing on an episode release; SxxExx is matched
 * first regardless, so this only ever sees titles that named no episode.
 */
const SEASON_ONLY = /(?:^|[._\s-])(?:S(\d{1,2})(?!\d)|Season[._\s-]*(\d{1,2})(?!\d))(?![._\s-]*(?:E|Episode)[._\s-]*\d)/i;

/**
 * Daily/date-based numbering: a full calendar date with an explicit month AND day.
 * Requires year-first separators so a bare 4-digit year ("Show.2024.1080p") can never
 * match — that would reclassify a plain movie release as an episode (the RSS movie e2e
 * canary runs "The.Test.Movie.2024.1080p" through this path, so month+day is a hard rule).
 * The month/day validity gates (1-12 / 1-31) also reject resolution tags (e.g. "1080"
 * fragments as month 10 + day 8 with no separator, so it never forms a valid pair).
 */
const DAILY_DATE = /\b((?:19|20)\d{2})[.\-_ ]+(\d{1,2})[.\-_ ]+(\d{1,2})\b/i;

/** Classic resolution numbers that a bare absolute guess must never resurrect. */
const ABSOLUTE_RESOLUTION_SET = new Set([480, 576, 720, 1080, 2160, 4320]);

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
      isSeasonPack: false,
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
      isSeasonPack: false,
      seriesTitle: extractSeriesTitle(title, se.index),
      quality: parseQualityFromTitle(title),
      year: parseYear(title),
      confidence: 1,
    };
  }

  // A season with no episode numbers is a season pack: it covers every episode of that
  // season. Confidence is below an explicit SxxExx match because the pattern is weaker.
  const pack = SEASON_ONLY.exec(title);
  if (pack) {
    return {
      season: Number(pack[1] ?? pack[2]),
      episodes: [],
      isMultiEpisode: false,
      isSeasonPack: true,
      seriesTitle: extractSeriesTitle(title, pack.index),
      quality: parseQualityFromTitle(title),
      year: parseYear(title),
      confidence: 0.8,
    };
  }

  // Daily/date-based numbering — only reached when no S&E/season was named.
  const daily = parseDailyDate(title);
  if (daily) {
    return {
      dailyDate: daily.date,
      episodes: [],
      isMultiEpisode: false,
      isSeasonPack: false,
      seriesTitle: extractSeriesTitle(title, daily.index),
      quality: parseQualityFromTitle(title),
      year: parseYear(title),
      confidence: 0.8,
    };
  }

  // Absolute/anime numbering — only reached when no S&E/season/date was named.
  const absolute = parseAbsoluteNumber(title);
  if (absolute !== undefined) {
    return {
      absoluteNumber: absolute.num,
      absoluteIsGuess: true,
      episodes: [],
      isMultiEpisode: false,
      isSeasonPack: false,
      seriesTitle: extractSeriesTitle(title, absolute.index),
      quality: parseQualityFromTitle(title),
      year: parseYear(title),
      confidence: 0.8,
    };
  }

  // nothing episodic found — probably a movie or an unparseable title
  return {
    seriesTitle: extractSeriesTitle(title, -1),
    episodes: [],
    isMultiEpisode: false,
    isSeasonPack: false,
    quality: parseQualityFromTitle(title),
    year: parseYear(title),
    confidence: 0,
  };
}

/** Extract a "YYYY-MM-DD" air date, or null. Requires an explicit month+day. */
function parseDailyDate(title: string): { date: string; index: number } | null {
  const m = DAILY_DATE.exec(title);
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return {
    date: `${m[1]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    index: m.index,
  };
}

/**
 * Extract a plausible absolute (anime) episode number, or undefined.
 *
 * A candidate must be a *standalone* numeric token — not fused into a word (x264, h265,
 * S05), not followed by a resolution unit (1080p/720p/…), not itself a resolution value,
 * not a 4-digit year. This is the classic source of the "Show.1080p"→absolute false
 * positive; the standalone + resolution-set + <1000 guards keep it out.
 */
function parseAbsoluteNumber(title: string): { num: number; index: number } | undefined {
  const re = /\d+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(title))) {
    const start = m.index!;
    const token = m[0];
    const end = start + token.length;
    const before = title[start - 1];
    const after = title[end];
    // Must be a standalone token (word char on either side means it's part of a word).
    if (before && /\w/.test(before)) continue;
    if (after && /\w/.test(after)) continue;
    // A resolution unit directly appended (1080p) disqualifies it as an episode number.
    if (after && /[pPiI]/.test(after)) continue;
    // A codec version suffix ("H.265", "X.265" — ubiquitous in anime HEVC encodes) is
    // a standalone number → reject it too. "Show.12" keeps working (the char before the
    // dot is a title letter, not h/x).
    if (before === "." && title[start - 2] && /[hx]/i.test(title[start - 2])) continue;
    const num = Number(token);
    if (num < 1 || num > 999) continue;
    if (ABSOLUTE_RESOLUTION_SET.has(num)) continue;
    return { num, index: start };
  }
  return undefined;
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

/** Whether a parsed release title plausibly matches a library title — media-neutral
 *  despite the historical name of its arguments; used for both series and movie matching. */
export function titleMatches(releaseName: string | undefined, libraryTitle: string): boolean {
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
