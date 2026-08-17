// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  parseReleaseTitle, parseQualityFromTitle, parseSeasonEpisode, parseReleaseGroup, determineModifier,
} from "./parser";

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

describe("RAD-010 source/modifier parsing", () => {
  it("distinguishes WEB-DL from WEBRip (and from bare WEB)", () => {
    expect(parseQualityFromTitle("Show.1080p.WEB-DL").source).toBe("webdl");
    expect(parseQualityFromTitle("Show.1080p.WEBRip").source).toBe("webrip");
    expect(parseQualityFromTitle("Show.1080p.WEBRIP").source).toBe("webrip");
    expect(parseQualityFromTitle("Show.2020.1080p.WEB").source).toBe("web");
  });

  it("detects remux/brdisk modifiers", () => {
    expect(determineModifier("Movie.2020.1080p.Remux.x265")).toBe("remux");
    expect(determineModifier("Movie.2020.1080p.BR-DISK.x265")).toBe("brdisk");
    expect(determineModifier("Movie.2020.1080p.Full.Disc")).toBe("brdisk");
    expect(determineModifier("Movie.2020.1080p.BluRay.x264")).toBe("none");
  });

  it("a Remux/BRDISK-only title is treated as BluRay source", () => {
    const q = parseQualityFromTitle("Movie.2020.1080p.Remux.x265");
    expect(q.source).toBe("bluray");
    expect(q.modifier).toBe("remux");
  });
});

describe("parseReleaseGroup", () => {
  it("extracts a trailing -GROUP token", () => {
    expect(parseReleaseGroup("Show.S01E01.1080p.WEB-DL.x264-DON")).toBe("DON");
    expect(parseReleaseGroup("Movie.2020.1080p.BluRay.x264-RARBG")).toBe("RARBG");
  });

  it("extracts a trailing [GROUP] token", () => {
    expect(parseReleaseGroup("Some.Release.1080p[MYGRP]")).toBe("MYGRP");
  });

  it("returns undefined for codec/resolution/tech trailing tokens", () => {
    expect(parseReleaseGroup("Movie.2020.1080p.x265")).toBeUndefined();
    expect(parseReleaseGroup("Movie.2020.1080p.Remux")).toBeUndefined();
    expect(parseReleaseGroup("Movie.2020.1080p.HDR")).toBeUndefined();
    expect(parseReleaseGroup("Movie.2020.1080p.DUAL")).toBeUndefined();
  });

  it("returns undefined for hash-like or episode-like tokens", () => {
    expect(parseReleaseGroup("Movie.2020.1080p.deadbeef01")).toBeUndefined();
    expect(parseReleaseGroup("Show.S01E01.1080p.WEB-DL-S01E01")).toBeUndefined();
  });

  it("strips a file extension before matching", () => {
    expect(parseReleaseGroup("Show.S01E01.1080p.WEB-DL.x264-DON.mkv")).toBe("DON");
  });

  it("returns undefined when there is no trailing group token", () => {
    expect(parseReleaseGroup("Movie.2020.1080p.BluRay.x264")).toBeUndefined();
  });
});
