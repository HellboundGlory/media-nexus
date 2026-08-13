// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  buildMovieFilename, buildEpisodeFilename, validateNamingTemplate, sanitizeForPath, namingPreview,
  type Quality,
} from "./naming";

const bluray1080 = { source: "bluray", resolution: "1080p", edition: "" } as unknown as Quality;
const web1080 = { source: "web", resolution: "1080p", edition: "" } as unknown as Quality;

describe("sanitizeForPath", () => {
  it("transliterates decomposable Latin diacritics instead of stripping them", () => {
    expect(sanitizeForPath("Léon")).toBe("Leon");
    expect(sanitizeForPath("Amélie")).toBe("Amelie");
  });

  it("preserves non-Latin scripts untouched (the B7 collision bug)", () => {
    expect(sanitizeForPath("東京物語")).toBe("東京物語");
    expect(sanitizeForPath("Кино")).toBe("Кино");
  });

  it("strips only filesystem-illegal characters", () => {
    expect(sanitizeForPath('Mission: Impossible')).toBe("Mission Impossible");
    expect(sanitizeForPath("Fate/stay night")).toBe("Fatestay night");
    expect(sanitizeForPath("A<>B")).toBe("AB");
  });

  it("collapses and trims whitespace", () => {
    expect(sanitizeForPath("  The   Matrix  ")).toBe("The Matrix");
  });
});

describe("buildMovieFilename", () => {
  it("substitutes Movie Title and Release Year", () => {
    const out = buildMovieFilename("{Movie Title} ({Release Year})", { title: "The Matrix", year: "1999", quality: bluray1080 });
    expect(out).toBe("The Matrix (1999)");
  });

  it("keeps literal spacing between tokens", () => {
    const out = buildMovieFilename("{Movie Title} - {Quality Full}", { title: "The Matrix", year: "1999", quality: bluray1080 });
    expect(out).toBe("The Matrix - Bluray 1080p");
  });

  it("sanitizes a title containing illegal characters", () => {
    const out = buildMovieFilename("{Movie Title} ({Release Year})", { title: "Mission: Impossible", year: "1996", quality: bluray1080 });
    expect(out).toBe("Mission Impossible (1996)");
  });

  it("falls back to Unknown for a missing year", () => {
    const out = buildMovieFilename("{Movie Title} ({Release Year})", { title: "TBD", year: null, quality: bluray1080 });
    expect(out).toBe("TBD (Unknown)");
  });
});

describe("buildEpisodeFilename", () => {
  const template = "{Series Title} - S{season:00}E{episode:00} - {Episode Title}";

  it("substitutes a single episode with zero-padded season/episode", () => {
    const out = buildEpisodeFilename(template, {
      seriesTitle: "Breaking Bad", season: 1, episodes: [{ number: 1, title: "Pilot" }], quality: web1080,
    });
    expect(out).toBe("Breaking Bad - S01E01 - Pilot");
  });

  it("formats multi-episode files in Sonarr's Range style (S01E01-02)", () => {
    const out = buildEpisodeFilename(template, {
      seriesTitle: "Breaking Bad", season: 1,
      episodes: [{ number: 1, title: "Pilot" }, { number: 2, title: "Cat's in the Bag..." }],
      quality: web1080,
    });
    expect(out).toBe("Breaking Bad - S01E01-02 - Pilot + Cat's in the Bag...");
  });

  it("deduplicates identical episode titles across a multi-episode file", () => {
    const out = buildEpisodeFilename(template, {
      seriesTitle: "Show", season: 1,
      episodes: [{ number: 1, title: "Part 1" }, { number: 2, title: "Part 1" }],
      quality: web1080,
    });
    expect(out).toBe("Show - S01E01-02 - Part 1");
  });

  it("sanitizes a non-Latin series title instead of collapsing it", () => {
    const out = buildEpisodeFilename(template, {
      seriesTitle: "進撃の巨人", season: 1, episodes: [{ number: 1, title: "To You" }], quality: web1080,
    });
    expect(out).toBe("進撃の巨人 - S01E01 - To You");
  });
});

describe("validateNamingTemplate", () => {
  it("accepts the default movie and episode templates", () => {
    expect(validateNamingTemplate("movie", "{Movie Title} ({Release Year})")).toEqual({ valid: true });
    expect(validateNamingTemplate("episode", "{Series Title} - S{season:00}E{episode:00} - {Episode Title}")).toEqual({ valid: true });
  });

  it("rejects an unknown token", () => {
    const result = validateNamingTemplate("movie", "{Nonexistent Token}");
    expect(result.valid).toBe(false);
  });

  it("rejects a token valid for the other kind", () => {
    const result = validateNamingTemplate("movie", "{Series Title}");
    expect(result.valid).toBe(false);
  });

  it("rejects an empty template", () => {
    expect(validateNamingTemplate("movie", "").valid).toBe(false);
    expect(validateNamingTemplate("movie", "   ").valid).toBe(false);
  });

  it("rejects a template whose literal text contains a path separator", () => {
    const result = validateNamingTemplate("movie", "{Movie Title}/{Release Year}");
    expect(result.valid).toBe(false);
  });

  it("rejects a template that produces empty output", () => {
    const result = validateNamingTemplate("movie", "::::");
    expect(result.valid).toBe(false);
  });
});

describe("namingPreview", () => {
  it("builds sample filenames without needing any DB data", () => {
    const preview = namingPreview("{Movie Title} ({Release Year})", "{Series Title} - S{season:00}E{episode:00} - {Episode Title}");
    expect(preview.movie).toBe("The Matrix (1999)");
    expect(preview.episode).toBe("Breaking Bad - S01E01 - Pilot");
  });
});
