// SPDX-License-Identifier: MIT
/**
 * Media info probing — pure types + mapping (media info probing, roadmap P2 item 6).
 *
 * This module is deliberately I/O-free so it can live in `domain` (which `integrations`
 * already depends on, never the reverse). The raw ffprobe output type is defined here too;
 * `packages/integrations/src/media-probe.ts` is the thin I/O wrapper that produces it via
 * execFile, keeping the dependency direction integrations -> domain intact.
 */

/** One `streams[]` entry from `ffprobe -show_streams -print_format json`. */
export interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  channels?: number;
  tags?: { language?: string };
}

/** The `format` object from `ffprobe -show_format -print_format json`. */
export interface FfprobeFormat {
  duration?: string;
}

/** Parsed `ffprobe -print_format json -show_format -show_streams` output. */
export interface RawFfprobeOutput {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

/**
 * The `mediaFile.mediaInfo` JSON blob (Sonarr/Radarr-aligned field *names*; the flat
 * `mediaFile.languages` column carries audio languages, matching those apps' semantics).
 * A type alias (not an interface) so it stays assignable to the schema's
 * `json<Record<string, unknown>>` column type.
 */
export type MediaInfo = {
  videoCodec: string | null;
  audioCodec: string | null;
  resolution: string | null; // `${width}x${height}` of the video stream
  runtimeSeconds: number | null;
  audioChannels: number | null;
  subtitles: { language: string | null }[]; // one entry per subtitle stream
}

const EMPTY_INFO: MediaInfo = {
  videoCodec: null,
  audioCodec: null,
  resolution: null,
  runtimeSeconds: null,
  audioChannels: null,
  subtitles: [],
};

/**
 * Map raw ffprobe output onto the `mediaFile.mediaInfo` blob and the `languages` column.
 * `languages` = deduped ISO 639-2 codes from the audio streams' `tags.language`. "und"
 * (undetermined) is the placeholder ffprobe emits when no language is tagged, so it is
 * dropped — reporting it as the file's language adds noise rather than information.
 */
export function toMediaInfo(raw: RawFfprobeOutput): { mediaInfo: MediaInfo; languages: string[] } {
  if (!raw || !Array.isArray(raw.streams)) return { mediaInfo: EMPTY_INFO, languages: [] };

  const video = raw.streams.find((s) => s.codec_type === "video");
  const audio = raw.streams.find((s) => s.codec_type === "audio");
  const subtitles = raw.streams
    .filter((s) => s.codec_type === "subtitle")
    .map((s) => ({ language: s.tags?.language ?? null }));

  const mediaInfo: MediaInfo = {
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    resolution: video && typeof video.width === "number" && typeof video.height === "number"
      ? `${video.width}x${video.height}`
      : null,
    runtimeSeconds: raw.format?.duration ? Number.parseFloat(raw.format.duration) || null : null,
    audioChannels: typeof audio?.channels === "number" ? audio.channels : null,
    subtitles,
  };

  const languages = Array.from(new Set(
    raw.streams
      .filter((s) => s.codec_type === "audio")
      .map((s) => s.tags?.language)
      .filter((l): l is string => Boolean(l) && l !== "und"),
  ));

  return { mediaInfo, languages };
}
