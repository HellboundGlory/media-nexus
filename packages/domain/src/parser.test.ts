// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { parseReleaseTitle, parseQualityFromTitle, parseSeasonEpisode } from "./parser";

describe("release title parser", () => {
  it("sniffs BluRay 1080p", () => {
    const p = parseReleaseTitle("The.Matrix.1999.1080p.BluRay.x264-GROUP");
    expect(p.quality.source).toBe("bluray");
    expect(p.quality.resolution).toBe("1080p");
    expect(p.year).toBe(1999);
    expect(p.maybeSeries).toBe(false);
  });

  it("sniffs WEB 720p + 4k", () => {
    expect(parseQualityFromTitle("Show.S01E02.720p.WEB-DL").resolution).toBe("720p");
    expect(parseQualityFromTitle("Movie.2023.2160p.WEB").resolution).toBe("2160p");
  });

  it("detects SxxExx episodes", () => {
    expect(parseSeasonEpisode("Breaking.Bad.S05E16.1080p.WEB-DL")).toEqual({ season: 5, episode: 16 });
    expect(parseReleaseTitle("Breaking.Bad.S05E16.1080p.WEB-DL").maybeSeries).toBe(true);
  });

  it("falls back to unknown when nothing matches", () => {
    const q = parseQualityFromTitle("some random title");
    expect(q.source).toBe("unknown");
    expect(q.resolution).toBe("unknown");
  });
});
