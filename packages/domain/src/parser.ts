// SPDX-License-Identifier: MIT
import type { Quality } from "./quality";

/**
 * Heuristic release-title parser: sniffs resolution/source/edition from a release
 * title the way the *arrs do ("Show.Name.2020.1080p.BluRay.x264-GROUP").
 * This is a first practical pass (M1) — refined in M2 with series/season/episode parsing.
 * Returns `null` when nothing confident is found (caller may fall back to "unknown").
 */
export interface ParsedReleaseTitle {
  quality: Quality;
  year?: number;
  maybeSeries: boolean; // contains SxxExx pattern → likely an episode release
  sxxexx?: { season: number; episode: number };
}

const RESOLUTIONS: { re: RegExp; label: Quality["resolution"] }[] = [
  { re: /2160p|4k|uhd/i, label: "2160p" },
  { re: /1080p|fhd|fullhd/i, label: "1080p" },
  { re: /720p|hd/i, label: "720p" },
  { re: /576p/i, label: "576p" },
  { re: /480p/i, label: "480p" },
];

const SOURCES: { re: RegExp; label: Quality["source"] }[] = [
  { re: /blu-?ray|brrip|bdrip|bluray/i, label: "bluray" },
  { re: /web-?dl|webrip|web/i, label: "web" },
  { re: /hdtv|hdtv-rip/i, label: "hdtv" },
  { re: /dvd-?rip|dvd/i, label: "dvd" },
  { re: /dvdscr|screener/i, label: "sd" },
  { re: /cam|camrip|ts\b/i, label: "sd" },
];

/** Parse best-quality guess from the title. Falls back to unknown/unknown. */
export function parseQualityFromTitle(title: string): Quality {
  const resolution = RESOLUTIONS.find((r) => r.re.test(title))?.label ?? "unknown";
  const source = SOURCES.find((s) => s.re.test(title))?.label ?? "unknown";
  return { source, resolution, edition: determineEdition(title) };
}

function determineEdition(title: string): string {
  if (/remastered|restored/i.test(title)) return "Remastered";
  if (/extended/i.test(title)) return "Extended";
  if (/director'?s cut|dc/i.test(title)) return "DirectorsCut";
  if (/unrated/i.test(title)) return "Unrated";
  return "";
}

const YEAR_RE = /\b(19\d{2}|20\d{2})\b/;
const SXXEXX_RE = /S(\d{1,2})E(\d{1,2})/i;

export function parseYear(title: string): number | undefined {
  const m = YEAR_RE.exec(title);
  return m ? Number(m[1]) : undefined;
}

export function parseSeasonEpisode(title: string): { season: number; episode: number } | undefined {
  const m = SXXEXX_RE.exec(title);
  if (!m) return undefined;
  return { season: Number(m[1]), episode: Number(m[2]) };
}

export function parseReleaseTitle(title: string): ParsedReleaseTitle {
  const sxxexx = parseSeasonEpisode(title);
  return {
    quality: parseQualityFromTitle(title),
    year: parseYear(title),
    maybeSeries: Boolean(sxxexx),
    sxxexx,
  };
}
