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

/** ISO 639-1/639-2 code -> release-title tokens that signal that language. */
const LANGUAGE_TERMS: Record<string, string[]> = {
  en: ["english", "eng"],
  fr: ["french", "vff", "vfq", "vof", "multi-french", "frenchaudio"],
  de: ["german", "deutsch"],
  es: ["spanish", "castellano"],
  it: ["italian"],
  pt: ["portuguese", "português", "portugues"],
  ja: ["japanese", "jap"],
  ko: ["korean", "korea"],
  zh: ["chinese", "mandarin", "cantonese", "chin"],
  hi: ["hindi"],
  ar: ["arabic"],
  ru: ["russian", "rus"],
  nl: ["dutch", "nederlands"],
  pl: ["polish"],
  sv: ["swedish", "swesub"],
  da: ["danish"],
  no: ["norwegian"],
  fi: ["finnish"],
  tr: ["turkish"],
  cs: ["czech"],
  el: ["greek"],
  he: ["hebrew"],
  th: ["thai"],
  vi: ["vietnamese"],
  hu: ["hungarian"],
  ro: ["romanian"],
  uk: ["ukrainian"],
  id: ["indonesian"],
};

/** Best-effort language detection from a release title. Conservatively returns the
 *  languages it can confidently name; returns [] for e.g. "MULTi" and unmarked titles
 *  rather than guessing. Feeds the custom-format LanguageSpec (roadmap P2). */
export function parseLanguages(title: string): string[] {
  const lower = title.toLowerCase();
  const out: string[] = [];
  for (const [code, terms] of Object.entries(LANGUAGE_TERMS)) {
    if (terms.some((t) => new RegExp(`(?:^|[._\\s\\-])${t.replace(/[^\w-]/g, "")}(?:[._\\s\\-]|$)`).test(lower))) {
      out.push(code);
    }
  }
  return out;
}

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
