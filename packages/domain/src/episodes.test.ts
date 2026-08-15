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

  describe("daily / date-based numbering", () => {
    it("parses an explicit air date in common daily-release forms", () => {
      const cases: [string, string][] = [
        ["The.Today.Show.2024.05.15.1080p.HDTV", "2024-05-15"],
        ["The.Today.Show.2024-05-15.1080p", "2024-05-15"],
        ["The.Today.Show - 2024 05 15 1080p", "2024-05-15"],
        ["TheTodayShow 2024-05-15 HDTV", "2024-05-15"],
      ];
      for (const [title, expected] of cases) {
        const m = parseEpisodeRelease(title);
        expect(m.dailyDate, title).toBe(expected);
        expect(m.season, title).toBeUndefined();
        expect(m.episodes, title).toEqual([]);
      }
    });

    it("never treats a bare 4-digit year as a date", () => {
      // The RSS movie e2e canary — a plain movie with a year+resolution must stay a movie.
      const m = parseEpisodeRelease("The.Test.Movie.2024.1080p.WEB-DL.x264-GROUP");
      expect(m.dailyDate).toBeUndefined();
      expect(m.confidence).toBe(0);
      expect(parseEpisodeRelease("Interstellar 2014 1080p BluRay x264").dailyDate).toBeUndefined();
    });

    it("does not misread a resolution tag as a date", () => {
      expect(parseEpisodeRelease("Show.2024.1080p.WEB").dailyDate).toBeUndefined();
    });
  });

  describe("absolute / anime numbering", () => {
    it("parses a lone absolute episode number", () => {
      const m = parseEpisodeRelease("[Erai-raws] Spy x Family - 12 [1080p][Multiple Subtitle]");
      expect(m.absoluteNumber).toBe(12);
      expect(m.absoluteIsGuess).toBe(true);
    });

    it("parses zero-padded absolute numbers", () => {
      expect(parseEpisodeRelease("Show - 012 1080p").absoluteNumber).toBe(12);
    });

    it("rejects resolution values and 4-digit years as absolute numbers", () => {
      expect(parseEpisodeRelease("Show.2024.1080p.WEB").absoluteNumber).toBeUndefined();
      expect(parseEpisodeRelease("Show.2160p.BluRay").absoluteNumber).toBeUndefined();
      expect(parseEpisodeRelease("Interstellar 2014 1080p").absoluteNumber).toBeUndefined();
    });

    it("does not fuse a number into a word (x264 / h265 / S05)", () => {
      for (const title of ["Show.S05E01.720p", "Show.x264-GROUP", "Show.720p.H.265"]) {
        const m = parseEpisodeRelease(title);
        // Whatever it resolves to, resolution-bearing tokens must not surface as episodes.
        if (!m.season && !m.isSeasonPack) expect(m.confidence).not.toBe(0.8);
      }
    });
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
