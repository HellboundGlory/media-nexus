// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  episodeTarget, movieTarget, hasMinimumAvailability, mediaLabel,
  targetEpisodeIds, isMovieItem, isSeriesItem,
  type EpisodeRef, type MovieMediaItem, type SeriesMediaItem,
} from "./media";

const ep = (over: Partial<EpisodeRef> = {}): EpisodeRef => ({
  id: "e1", seasonNumber: 1, episodeNumber: 1, title: "", monitored: true, hasFile: false, ...over,
});

const movie: MovieMediaItem = {
  id: "m1", mediaType: "movie", title: "Dune", year: 2021, overview: "", monitored: true,
  qualityProfileId: null, rootFolderPath: "/media", tags: [], addedAt: "2026-01-01T00:00:00.000Z",
  tmdbId: 438631, imdbId: null, releaseDate: "2021-10-22", minimumAvailability: "released",
  hasFile: false,
};

const series: SeriesMediaItem = {
  id: "s1", mediaType: "series", title: "Severance", year: 2022, overview: "", monitored: true,
  qualityProfileId: null, rootFolderPath: "/media", tags: [], addedAt: "2026-01-01T00:00:00.000Z",
  tvdbId: 371980, tmdbId: null, imdbId: null, seriesType: "standard", network: "Apple TV+",
};

describe("media item helpers", () => {
  it("narrows by media type", () => {
    expect(isMovieItem(movie)).toBe(true);
    expect(isSeriesItem(movie)).toBe(false);
    expect(isSeriesItem(series)).toBe(true);
  });

  it("labels with the year when known", () => {
    expect(mediaLabel(movie)).toBe("Dune (2021)");
    expect(mediaLabel({ ...series, year: undefined })).toBe("Severance");
  });
});

describe("release targets", () => {
  it("collects episode ids and ignores them for movies", () => {
    expect(targetEpisodeIds(movieTarget("m1"))).toEqual([]);
    const target = episodeTarget("s1", 2, [ep({ id: "a" }), ep({ id: "b" })]);
    expect(targetEpisodeIds(target)).toEqual(["a", "b"]);
  });

  it("marks season packs", () => {
    expect(episodeTarget("s1", 3, [ep()], true).isSeasonPack).toBe(true);
    expect(episodeTarget("s1", 3, [ep()]).isSeasonPack).toBe(false);
  });
});

describe("minimum availability", () => {
  const at = (iso: string) => new Date(iso);

  it("announced is always available", () => {
    expect(hasMinimumAvailability({ minimumAvailability: "announced", releaseDate: null })).toBe(true);
  });

  it("released waits for the release date to pass", () => {
    const m = { minimumAvailability: "released" as const, releaseDate: "2026-12-01" };
    expect(hasMinimumAvailability(m, at("2026-11-30T00:00:00Z"))).toBe(false);
    expect(hasMinimumAvailability(m, at("2026-12-02T00:00:00Z"))).toBe(true);
  });

  it("is not available when the date is missing or unparseable", () => {
    expect(hasMinimumAvailability({ minimumAvailability: "released", releaseDate: null })).toBe(false);
    expect(hasMinimumAvailability({ minimumAvailability: "released", releaseDate: "soon" })).toBe(false);
  });
});
