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
  // RAD-010 split: WEB-DL and WEBRip are genuinely distinct sources. Ordering matters —
  // the more specific webdl/webrip patterns run BEFORE the coarse `\bweb\b` so a
  // "WEB-DL" title can't be swallowed by the generic web entry.
  { re: /web-?dl/i, label: "webdl" },
  { re: /web-?rip/i, label: "webrip" },
  { re: /\bweb\b/i, label: "web" },
  { re: /hdtv|hdtv-rip/i, label: "hdtv" },
  { re: /dvd-?rip|dvd/i, label: "dvd" },
  { re: /dvdscr|screener/i, label: "sd" },
  { re: /cam|camrip|ts\b/i, label: "sd" },
];

/** Quality modifier detection (RAD-010). Remux/BR-DISK are a second axis, not sources.
 *  Separators allow the common `-`, `_`, `.` or space forms ("BR-DISK", "BR.Disc", "Full Disc"). */
const MODIFIERS: { re: RegExp; label: Quality["modifier"] }[] = [
  { re: /remux/i, label: "remux" },
  { re: /br[ ._-]?dis[ck]|full[ ._-]?dis[ck]|bdmv/i, label: "brdisk" },
];

export function determineModifier(title: string): Quality["modifier"] {
  return MODIFIERS.find((m) => m.re.test(title))?.label ?? "none";
}

/** Parse best-quality guess from the title. Falls back to unknown/unknown. */
export function parseQualityFromTitle(title: string): Quality {
  const resolution = RESOLUTIONS.find((r) => r.re.test(title))?.label ?? "unknown";
  let source = SOURCES.find((s) => s.re.test(title))?.label ?? "unknown";
  const modifier = determineModifier(title);
  // A "Remux"/"BR-DISK" title that names no explicit source is, by definition, a BluRay
  // disc — upstream treats these as BluRay. Defaulting to bluray keeps the registry id
  // (and thus ranking) sensible instead of "unknown:remux".
  if (source === "unknown" && modifier !== "none") source = "bluray";
  return { source, resolution: resolution as Quality["resolution"], edition: determineEdition(title), modifier };
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

// Tokens that are never a release group even if they occupy the trailing "-TOKEN" /
// "[TOKEN]" slot — resolution, codec, tech, language and status markers the title
// parser already recognizes elsewhere, and which would be noisy false group names.
const NON_GROUP_TOKENS = new Set([
  "x264", "x265", "h264", "h265", "hevc", "avc", "av1", "vp9",
  "hdr", "sdr", "dv", "hdr10", "hdr10plus", "dolbyvision", "dolby", "atmos", "vision",
  "remux", "brdisk", "bdr", "bdmv", "uhd", "4k", "2160p", "1080p", "720p", "576p", "480p",
  "webdl", "web-dl", "webrip", "web", "hdtv", "bluray", "blu-ray", "brrip", "bdrip", "dvd",
  "dts", "dtshd", "dtsx", "truehd", "ddp", "dd", "ma", "ac3", "eac3", "flac", "aac", "pcm",
  "multi", "dual", "proper", "repack", "repacked", "internal", "scene", "nuked",
  "subbed", "dubbed", "extended", "unrated", "remastered", "restored", "directors", "collectors",
]);

const EXT_RE = /\.[a-z0-9]{2,4}$/i;

/**
 * Heuristic release-group extraction (SON-025). An ORIGINAL v1 implementation of the
 * general scene/P2P naming convention (trailing `-GROUP` or `[GROUP]`) — deliberately
 * NOT a port of upstream's `ReleaseGroupParser.cs` (GPLv3 — its specific curated
 * exception-group list is another codebase's creative content, which this MIT repo must
 * not copy; see the task's licensing note). Being chicken-and-groups-less precise than
 * upstream's battle-tested version is an explicit v1 tradeoff.
 *
 * Returns undefined when no confident trailing group token is found or when the token
 * is more plausibly a resolution/codec/season/episode/hash marker. */
export function parseReleaseGroup(title: string): string | undefined {
  const t = title.replace(EXT_RE, "");
  let group: string | undefined;
  const bracket = /\[([a-zA-Z0-9]{2,30})\]\s*$/.exec(t);
  if (bracket) {
    group = bracket[1];
  } else {
    const dash = /-([a-zA-Z0-9]{2,30})$/.exec(t);
    group = dash ? dash[1] : undefined;
  }
  if (!group) return undefined;
  if (!isPlausibleGroup(group)) return undefined;
  return group;
}

function isPlausibleGroup(g: string): boolean {
  if (g.length < 2 || g.length > 30) return false;
  if (/^\d+$/.test(g)) return false;
  if (/^\d{1,3}[pP]$/.test(g)) return false; // resolution marker (1080p)
  if (/^(?:s\d{1,2}e\d{1,3}|e\d{1,3}|s\d{1,2})$/i.test(g)) return false; // episode/season ref
  if (/^[0-9a-f]{8,}$/i.test(g)) return false; // hash-like release id
  if (NON_GROUP_TOKENS.has(g.toLowerCase())) return false;
  return true;
}
