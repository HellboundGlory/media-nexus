// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { parseEpisodeRelease, titleMatches, normalizeReleaseSeriesName } from "./episodes";

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
    expect(m.isSeasonPack).toBe(false);
  });

  it("detects season packs in their common forms", () => {
    for (const title of [
      "Test.Show.S02.1080p.WEB-DL",
      "Test Show Season 2 COMPLETE 1080p",
      "Test.Show.Complete.Season.2.1080p.WEB",
      "Test.Show.Season.2.1080p.WEB",
    ]) {
      const m = parseEpisodeRelease(title);
      expect(m.season, title).toBe(2);
      expect(m.episodes, title).toEqual([]);
      expect(m.isSeasonPack, title).toBe(true);
    }
  });

  it("does not mistake an episode release for a season pack", () => {
    for (const title of ["Test.Show.S02E05.1080p", "Test Show Season 2 Episode 5", "Test.Show.S02E05-E06.720p"]) {
      expect(parseEpisodeRelease(title).isSeasonPack, title).toBe(false);
    }
  });

  it("does not read a season out of a movie title", () => {
    const m = parseEpisodeRelease("Interstellar 2014 1080p BluRay x264");
    expect(m.season).toBeUndefined();
  });
});

describe("title matching (series and movies)", () => {
  it("matches dotted/simple forms with tolerance for articles", () => {
    expect(titleMatches("Breaking.Bad", "Breaking Bad")).toBe(true);
    expect(titleMatches("breaking-bad", "BreakingBad")).toBe(true);
    expect(titleMatches("the-last-of-us", "The Last of Us")).toBe(true);
  });

  it("rejects unrelated names", () => {
    expect(titleMatches("Dune", "Breaking Bad")).toBe(false);
  });

  it("matches a movie release title with a trailing year against the bare library title", () => {
    // parseEpisodeRelease()'s "probably a movie" fallback extracts a seriesTitle that still
    // includes the year (nothing in TITLE_STOP_PATTERNS strips a bare 4-digit year) —
    // titleMatches's substring/startsWith tolerance must still line it up.
    expect(titleMatches("dune 2021", "Dune")).toBe(true);
    expect(titleMatches("the matrix 1999", "The Matrix")).toBe(true);
  });
});
