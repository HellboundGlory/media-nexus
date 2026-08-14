// SPDX-License-Identifier: MIT
/** Pure mapper coverage for media-info probing (roadmap P2 item 6). */
import { describe, it, expect } from "vitest";
import { toMediaInfo, type RawFfprobeOutput } from "./media-info";

describe("toMediaInfo", () => {
  it("maps video/audio/subtitle streams and derives audio languages", () => {
    const raw: RawFfprobeOutput = {
      format: { duration: "125.433" },
      streams: [
        { codec_type: "video", codec_name: "hevc", width: 3840, height: 2160 },
        { codec_type: "audio", codec_name: "aac", channels: 6, tags: { language: "eng" } },
        { codec_type: "audio", codec_name: "ac3", channels: 2, tags: { language: "eng" } },
        { codec_type: "audio", codec_name: "ac3", channels: 2, tags: { language: "spa" } },
        { codec_type: "subtitle", tags: { language: "eng" } },
        { codec_type: "subtitle", tags: {} },
      ],
    };

    const { mediaInfo, languages } = toMediaInfo(raw);
    expect(mediaInfo).toEqual({
      videoCodec: "hevc",
      audioCodec: "aac",
      resolution: "3840x2160",
      runtimeSeconds: 125.433,
      audioChannels: 6,
      subtitles: [{ language: "eng" }, { language: null }],
    });
    // deduped, order-preserving audio languages
    expect(languages).toEqual(["eng", "spa"]);
  });

  it("drops the und placeholder from languages", () => {
    const raw: RawFfprobeOutput = {
      streams: [{ codec_type: "audio", tags: { language: "und" } }],
    };
    const { languages } = toMediaInfo(raw);
    expect(languages).toEqual([]);
  });

  it("handles a missing stream list / absent fields", () => {
    expect(toMediaInfo({})).toEqual({
      mediaInfo: {
        videoCodec: null, audioCodec: null, resolution: null,
        runtimeSeconds: null, audioChannels: null, subtitles: [],
      },
      languages: [],
    });
    const noFormat = toMediaInfo({ streams: [{ codec_type: "video", codec_name: "h264" }] });
    expect(noFormat.mediaInfo.runtimeSeconds).toBeNull();
    expect(noFormat.mediaInfo.resolution).toBeNull();
  });

  it("only picks the first video / audio stream and non-finite durations", () => {
    const raw: RawFfprobeOutput = {
      format: { duration: "garbage" },
      streams: [
        { codec_type: "video", codec_name: "h264", width: 1920, height: 1080 },
        { codec_type: "subtitle" },
      ],
    };
    const { mediaInfo, languages } = toMediaInfo(raw);
    expect(mediaInfo.videoCodec).toBe("h264");
    expect(mediaInfo.audioCodec).toBeNull();
    expect(mediaInfo.runtimeSeconds).toBeNull();
    expect(languages).toEqual([]);
  });
});
