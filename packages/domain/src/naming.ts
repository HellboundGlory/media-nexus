// SPDX-License-Identifier: MIT
/**
 * Token-based file naming (gap report B7, roadmap P1) — the general, user-configurable
 * *filename* template consumed by `media.naming`. This is deliberately not the fixed
 * "Title (Year)" folder-per-title convention in `apps/api/src/media/naming.helpers.ts`
 * (`movieFolderName`/`seriesFolderName`), which import and disk-scan must agree on
 * regardless of any user template.
 */
import { qualityId, qualityMeta, type Quality } from "./quality";

export const MOVIE_TOKENS = ["Movie Title", "Release Year", "Quality Full"] as const;
export const EPISODE_TOKENS = ["Series Title", "season", "episode", "Episode Title", "Quality Full"] as const;

type TemplateSegment = { kind: "literal"; text: string } | { kind: "token"; name: string; pad?: number };

/** Parses `{Token Name}` / `{token:00}` segments out of a template. The padding suffix
 *  (a run of `0`s) sets the minimum digit width for numeric tokens (season/episode). */
export function parseTemplate(template: string): TemplateSegment[] {
  const segments: TemplateSegment[] = [];
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf("{", i);
    if (open === -1) {
      segments.push({ kind: "literal", text: template.slice(i) });
      break;
    }
    if (open > i) segments.push({ kind: "literal", text: template.slice(i, open) });
    const close = template.indexOf("}", open);
    if (close === -1) {
      segments.push({ kind: "literal", text: template.slice(open) });
      break;
    }
    const inner = template.slice(open + 1, close);
    const [name, padSpec] = inner.split(":");
    segments.push({ kind: "token", name: name.trim(), pad: padSpec ? padSpec.length : undefined });
    i = close + 1;
  }
  return segments;
}

/** Filesystem-illegal characters across Windows/exFAT/most network shares, plus control
 *  chars. Anything else (including non-Latin scripts) passes through untouched. */
// eslint-disable-next-line no-control-regex -- deliberately stripping control characters from filenames
const ILLEGAL_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

/** Transliterates decomposable Latin diacritics (é→e), then strips characters illegal in
 *  a filename. Used on template literal text, where whitespace is author-controlled
 *  (e.g. the deliberate `" ("` between two tokens) and must not be collapsed or trimmed. */
function stripIllegalForPath(name: string): string {
  return name.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(ILLEGAL_CHARS, "");
}

/** Same transliteration/stripping as `stripIllegalForPath`, plus whitespace collapse and
 *  trim — for a whole title/name string coming from external data (TMDB, an episode
 *  title, …), where irregular whitespace is a data-hygiene concern rather than a
 *  deliberate template choice. Replaces the old Latin-only whitelist strip, which reduced
 *  any non-Latin title (Cyrillic, CJK, …) to an empty string and caused a real folder
 *  collision (gap report B7). */
export function sanitizeForPath(name: string): string {
  return stripIllegalForPath(name).replace(/\s+/g, " ").trim();
}

function pad(n: number, width: number | undefined): string {
  return width ? String(n).padStart(width, "0") : String(n);
}

function qualityFull(q: Quality): string {
  return qualityMeta(qualityId(q))?.title ?? "Unknown";
}

function render(segments: TemplateSegment[], resolve: (name: string, pad: number | undefined) => string): string {
  return segments.map((s) => (s.kind === "literal" ? stripIllegalForPath(s.text) : sanitizeForPath(resolve(s.name, s.pad)))).join("");
}

export interface MovieNamingInput {
  title: string;
  year?: string | null;
  quality: Quality;
}

export function buildMovieFilename(template: string, input: MovieNamingInput): string {
  return render(parseTemplate(template), (name) => {
    switch (name) {
      case "Movie Title": return input.title;
      case "Release Year": return input.year ? input.year.slice(0, 4) : "Unknown";
      case "Quality Full": return qualityFull(input.quality);
      default: return "";
    }
  });
}

export interface EpisodeNamingInput {
  seriesTitle: string;
  season: number;
  episodes: { number: number; title: string }[];
  quality: Quality;
}

export function buildEpisodeFilename(template: string, input: EpisodeNamingInput): string {
  return render(parseTemplate(template), (name, padWidth) => {
    switch (name) {
      case "Series Title": return input.seriesTitle;
      case "season": return pad(input.season, padWidth);
      // Sonarr's "Range" multi-episode style: {season:00}E{episode:00} renders S01E01-02.
      case "episode": return input.episodes.map((e) => pad(e.number, padWidth)).join("-");
      case "Episode Title": return [...new Set(input.episodes.map((e) => e.title).filter(Boolean))].join(" + ");
      case "Quality Full": return qualityFull(input.quality);
      default: return "";
    }
  });
}

export type NamingValidation = { valid: true } | { valid: false; error: string };

const SAMPLE_MOVIE: MovieNamingInput = { title: "The Matrix", year: "1999", quality: { source: "bluray", resolution: "1080p", edition: "" } };
const SAMPLE_EPISODE: EpisodeNamingInput = {
  seriesTitle: "Breaking Bad", season: 1,
  episodes: [{ number: 1, title: "Pilot" }],
  quality: { source: "web", resolution: "1080p", edition: "" },
};

/** Rejects unknown tokens, a template that produces empty output, and literal text
 *  containing a path separator (the template governs the filename only — folder
 *  placement is the fixed movieFolderName/seriesFolderName convention). */
export function validateNamingTemplate(kind: "movie" | "episode", template: string): NamingValidation {
  if (!template || !template.trim()) return { valid: false, error: "template must not be empty" };
  const segments = parseTemplate(template);
  const vocabulary: readonly string[] = kind === "movie" ? MOVIE_TOKENS : EPISODE_TOKENS;
  for (const s of segments) {
    if (s.kind === "literal" && /[/\\]/.test(s.text)) {
      return { valid: false, error: `template must not contain a path separator: "${s.text}"` };
    }
    if (s.kind === "token" && !vocabulary.includes(s.name)) {
      return { valid: false, error: `unknown token "{${s.name}}"` };
    }
  }
  const built = kind === "movie" ? buildMovieFilename(template, SAMPLE_MOVIE) : buildEpisodeFilename(template, SAMPLE_EPISODE);
  if (!built.trim()) return { valid: false, error: "template produces an empty filename" };
  return { valid: true };
}

export function namingPreview(movieTemplate: string, episodeTemplate: string): { movie: string; episode: string } {
  return {
    movie: buildMovieFilename(movieTemplate, SAMPLE_MOVIE),
    episode: buildEpisodeFilename(episodeTemplate, SAMPLE_EPISODE),
  };
}
