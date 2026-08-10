// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { parseEpisodeRelease, seriesTitleMatches, normalizeReleaseSeriesName } from "./episodes";

describe("episode release parser", () => {
  it("parses SxxExx releases and sniffs quality", () => {
    const m = parseEpisodeRelease("Breaking.Bad.S05E16.1080p.WEB-DL.x264-GROUP");
    expect(m.season).toBe(5);
    expect(m.episodes).toEqual([16]);
    expect(m.isMultiEpisode).toBe(false);
    expect(m.quality.resolution).toBe("1080p");
    expect(m.quality.source).toBe("web");
    expect(m.confidence).toBe(1);
    expect(normalizeReleaseSeriesName(m.seriesTitle ?? "")).toBe("breaking bad");
  });

  it("parses multi-episode packs (S05E16-E17 and S05E16E17)", () => {
    expect(parseEpisodeRelease("Show.S05E16-E17.720p.WEB").episodes).toEqual([16, 17]);
    expect(parseEpisodeRelease("Show.S05E16E17.720p.WEB").episodes).toEqual([16, 17]);
  });

  it("parses 'Season X - Episode Y'", () => {
    const m = parseEpisodeRelease("Fargo - Season 5 - Episode 01 1080p HDTV");
    expect(m.season).toBe(5);
    expect(m.episodes).toEqual([1]);
  });

  it("strips quality/encode tokens from the series name", () => {
    const m = parseEpisodeRelease("The.Last.of.Us.S01E03.2160p.BluRay.x265");
    expect(normalizeReleaseSeriesName(m.seriesTitle ?? "")).toBe("the last of us");
  });

  it("returns low confidence for non-episodic titles", () => {
    const m = parseEpisodeRelease("Interstellar 2014 1080p BluRay x264");
    expect(m.confidence).toBe(0);
    expect(m.episodes).toEqual([]);
  });
});

describe("series name matching", () => {
  it("matches dotted/simple forms with tolerance for articles", () => {
    expect(seriesTitleMatches("Breaking.Bad", "Breaking Bad")).toBe(true);
    expect(seriesTitleMatches("breaking-bad", "BreakingBad")).toBe(true);
    expect(seriesTitleMatches("the-last-of-us", "The Last of Us")).toBe(true);
  });

  it("rejects unrelated names", () => {
    expect(seriesTitleMatches("Dune", "Breaking Bad")).toBe(false);
  });
});
