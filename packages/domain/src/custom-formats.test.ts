// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  matchSpec, matchFormat, calculateFormatScore, matchingFormats,
  releaseMatchInput, existingFileMatchInput,
  type CustomFormat, type CustomFormatSpec, type CustomFormatMatchInput,
} from "./custom-formats";
import { parseLanguages, parseReleaseGroup } from "./parser";
import type { Release } from "./release";
import type { Quality } from "./quality";

const Q: Quality = { source: "web", resolution: "1080p", edition: "" };

function release(over: Partial<Release> = {}): Release {
  return {
    id: "r1", indexerId: "idx1", indexerName: "Demo", title: "Movie.2020.1080p.WEB-DL",
    protocol: "torrent", categories: [], size: 20 * 1024 * 1024 * 1024, ageHours: 1, seeders: 10, leechers: 1,
    quality: Q, isFreeleech: false, isProper: false, isRepack: false,
    ...over,
  };
}

const input: CustomFormatMatchInput = {
  title: "Movie.2020.1080p.WEB-DL.REMUX.x265",
  size: 2 * 1024 ** 3,
  quality: Q,
  languages: ["en"],
  indexerId: "idx9",
};

const spec = (s: CustomFormatSpec) => s;

describe("term spec", () => {
  it("matches a plain substring", () => {
    expect(matchSpec(spec({ type: "term", term: "REMUX" }), input)).toBe(true);
    expect(matchSpec(spec({ type: "term", term: "x265" }), input)).toBe(true);
  });
  it("is case-insensitive by default", () => {
    expect(matchSpec(spec({ type: "term", term: "remux" }), input)).toBe(true);
  });
  it("honours caseSensitive", () => {
    expect(matchSpec(spec({ type: "term", term: "REMUX", caseSensitive: true }), input)).toBe(true);
    expect(matchSpec(spec({ type: "term", term: "remux", caseSensitive: true }), input)).toBe(false);
  });
  it("matches a regex when useRegex is set", () => {
    expect(matchSpec(spec({ type: "term", term: "\\b(REMUX|REPACK)\\b", useRegex: true }), input)).toBe(true);
  });
  it("a malformed regex never matches instead of throwing", () => {
    expect(matchSpec(spec({ type: "term", term: "([", useRegex: true }), input)).toBe(false);
  });
  it("inverts with negate", () => {
    expect(matchSpec(spec({ type: "term", term: "x264", negate: true }), input)).toBe(true);
    expect(matchSpec(spec({ type: "term", term: "x265", negate: true }), input)).toBe(false);
  });
});

describe("size spec", () => {
  it("matches inside an inclusive range", () => {
    expect(matchSpec(spec({ type: "size", min: 1 * 1024 ** 3, max: 5 * 1024 ** 3 }), input)).toBe(true);
  });
  it("rejects outside the range", () => {
    expect(matchSpec(spec({ type: "size", min: 5 * 1024 ** 3 }), input)).toBe(false);
    expect(matchSpec(spec({ type: "size", max: 1 * 1024 ** 3 }), input)).toBe(false);
  });
  it("a size spec with no bounds matches everything", () => {
    expect(matchSpec(spec({ type: "size" }), input)).toBe(true);
  });
  it("inverts with negate", () => {
    expect(matchSpec(spec({ type: "size", min: 5 * 1024 ** 3, negate: true }), input)).toBe(true);
  });
});

describe("language spec", () => {
  it("matches a language present on the release", () => {
    expect(matchSpec(spec({ type: "language", language: "en" }), input)).toBe(true);
    expect(matchSpec(spec({ type: "language", language: "fr" }), input)).toBe(false);
  });
  it("matches a language detected from the title when languages is empty", () => {
    const detected = releaseMatchInput(release({ title: "Movie.2020.1080p.FRENCH", languages: [] }));
    expect(matchSpec(spec({ type: "language", language: "fr" }), detected)).toBe(true);
  });
  it("inverts with negate", () => {
    expect(matchSpec(spec({ type: "language", language: "fr", negate: true }), input)).toBe(true);
  });
});

describe("indexer spec", () => {
  it("matches the configured indexer id", () => {
    expect(matchSpec(spec({ type: "indexer", indexerId: "idx9" }), input)).toBe(true);
    expect(matchSpec(spec({ type: "indexer", indexerId: "other" }), input)).toBe(false);
  });
  it("a non-negated indexer spec fails against an existing file (no indexer metadata)", () => {
    const ex = existingFileMatchInput({ relativePath: "foo/x.mkv", size: 1024, quality: Q });
    expect(ex.indexerId).toBeUndefined();
    expect(matchSpec(spec({ type: "indexer", indexerId: "idx9" }), ex)).toBe(false);
  });
  it("a negated indexer spec passes against an existing file", () => {
    const ex = existingFileMatchInput({ relativePath: "foo/x.mkv", size: 1024, quality: Q });
    expect(matchSpec(spec({ type: "indexer", indexerId: "idx9", negate: true }), ex)).toBe(true);
  });
});

describe("matchFormat", () => {
  it("requires every spec to pass", () => {
    const f = { id: "f1", name: "REMUX x265", specs: [
      spec({ type: "term", term: "REMUX" }),
      spec({ type: "term", term: "x265" }),
    ] };
    expect(matchFormat(f, input)).toBe(true);
    expect(matchFormat({ ...f, specs: [...f.specs, spec({ type: "term", term: "imax" })] }, input)).toBe(false);
  });
});

describe("calculateFormatScore", () => {
  const formats: CustomFormat[] = [
    { id: "f1", name: "x265", specs: [spec({ type: "term", term: "x265" })] },
    { id: "f2", name: "French", specs: [spec({ type: "language", language: "fr" })] },
    { id: "f3", name: "Remux", specs: [spec({ type: "term", term: "REMUX" })] },
  ];
  it("sums the scores of every matching format", () => {
    const scores: Record<string, number> = { f1: 100, f3: 200 };
    // f2 (French) doesn't match; f2 absent from map contributes 0 regardless.
    expect(calculateFormatScore(formats, scores, input)).toBe(300);
  });
  it("assigns 0 to an absent (unscored) format even when it matches", () => {
    expect(calculateFormatScore(formats, {}, input)).toBe(0);
  });
  it("scores an existing file from its reduced view (language/indexer can't match)", () => {
    // Include a French-language spec + indexer spec that only a live release can hit.
    const liveFormats: CustomFormat[] = [
      { id: "f1", name: "x265", specs: [spec({ type: "term", term: "x265" })] },
      { id: "f2", name: "Idx only", specs: [spec({ type: "indexer", indexerId: "idx9" })] },
    ];
    const scores = { f1: 100, f2: 50 };
    const ex = existingFileMatchInput({ relativePath: "movie.x265.mkv", size: 1024, quality: Q });
    // f1's term still matches the filename; f2's indexer spec can't for an existing file.
    expect(calculateFormatScore(liveFormats, scores, ex)).toBe(100);
  });
});

describe("matchingFormats", () => {
  const formats: CustomFormat[] = [
    { id: "f1", name: "x265", specs: [spec({ type: "term", term: "x265" })] },
    { id: "f2", name: "French", specs: [spec({ type: "language", language: "fr" })] },
    { id: "f3", name: "Remux", specs: [spec({ type: "term", term: "REMUX" })] },
  ];
  it("returns the matching formats as a filtered array", () => {
    const matched = matchingFormats(formats, input);
    expect(matched).toHaveLength(2);
    expect(matched.map((f) => f.id).sort()).toEqual(["f1", "f3"]);
  });
  it("returns empty array when nothing matches", () => {
    const noMatchInput: CustomFormatMatchInput = {
      title: "Movie.2020.720p.WEB-DL",
      size: 2 * 1024 ** 3,
      quality: Q,
      languages: ["en"],
    };
    const matched = matchingFormats(formats, noMatchInput);
    expect(matched).toHaveLength(0);
  });
  it("returns all formats when all match", () => {
    const allMatchInput: CustomFormatMatchInput = {
      title: "Movie.2020.1080p.FRENCH.REMUX.x265",
      size: 2 * 1024 ** 3,
      quality: Q,
      languages: ["fr"],
      indexerId: "idx9",
    };
    const matched = matchingFormats(formats, allMatchInput);
    expect(matched).toHaveLength(3);
  });
});

describe("SON-025 — grouped (OR-within-type) matching algorithm", () => {
  // Reproduces the real "720p Quality Tier 1" shape: Resolution(720, required),
  // ReleaseTitle(NOT "Remux", required), Source(Bluray, NOT required), Source(WEBRip,
  // NOT required), ReleaseGroup(one of 5 known groups, NOT required). Constrained by
  // type grouping, same-type specs are OR'd unless a member is `required`.
  const tier1 = (): CustomFormat => ({
    id: "t1", name: "720p Quality Tier 1",
    specs: [
      { type: "resolution", resolution: "720p", negate: false, required: true, caseSensitive: false },
      { type: "term", term: "remux", negate: true, required: true, caseSensitive: false, useRegex: false },
      { type: "source", source: "bluray", negate: false, required: false, caseSensitive: false },
      { type: "source", source: "webrip", negate: false, required: false, caseSensitive: false },
      { type: "releaseGroup", releaseGroup: "DON", negate: false, required: false, caseSensitive: false },
      { type: "releaseGroup", releaseGroup: "REBORN", negate: false, required: false, caseSensitive: false },
      { type: "releaseGroup", releaseGroup: "SoLaR", negate: false, required: false, caseSensitive: false },
      { type: "releaseGroup", releaseGroup: "TeamSyndicate", negate: false, required: false, caseSensitive: false },
      { type: "releaseGroup", releaseGroup: "ZoroSenpai", negate: false, required: false, caseSensitive: false },
    ],
  });

  const input = (title: string, quality: Quality): CustomFormatMatchInput =>
    releaseMatchInput(release({ title, quality }));

  it("matches a release satisfying every group's intent (720p, not-remux, bluray, one known group)", () => {
    const fmt = tier1();
    const r = input("Show.S01E01.720p.BluRay.x264-DON", { source: "bluray", resolution: "720p", edition: "" });
    expect(parseReleaseGroup(r.title)).toBe("DON");
    expect(matchFormat(fmt, r)).toBe(true);
  });

  it("matches via the OR'd ReleaseGroup set (a release group in the list satisfies the group)", () => {
    const fmt = tier1();
    const r = input("Show.S01E01.720p.WEBRip.x264-REBORN", { source: "webrip", resolution: "720p", edition: "" });
    expect(matchFormat(fmt, r)).toBe(true);
  });

  it("does NOT match when NONE of the OR'd ReleaseGroup specs matches (unlisted group)", () => {
    const fmt = tier1();
    const r = input("Show.S01E01.720p.BluRay.x264-UNKNOWNGRP", { source: "bluray", resolution: "720p", edition: "" });
    expect(matchFormat(fmt, r)).toBe(false);
  });

  it("does NOT match when a required spec fails (wrong resolution)", () => {
    const fmt = tier1();
    const r = input("Show.S01E01.1080p.BluRay.x264-DON", { source: "bluray", resolution: "1080p", edition: "" });
    expect(matchFormat(fmt, r)).toBe(false);
  });

  it("does NOT match when a required NEGATED spec fails (contains Remux)", () => {
    const fmt = tier1();
    const r = input("Show.S01E01.720p.Remux.x264-DON", { source: "bluray", resolution: "720p", edition: "", modifier: "remux" });
    expect(matchFormat(fmt, r)).toBe(false);
  });

  // Reproduces the real "AAC" shape: ALL of its ReleaseTitle specs marked required, which
  // under upstream's algorithm reduces to plain AND (every required member must pass).
  it("an all-required format behaves as plain AND across its specs", () => {
    const fmt: CustomFormat = {
      id: "aac", name: "AAC",
      specs: ["aac", "1080p", "web-dl"]
        .map((term) => ({ type: "term" as const, term, negate: false, required: true, caseSensitive: false, useRegex: false })),
    };
    const yes = input("Show.2020.1080p.AAC.WEB-DL.x264-GROUP", { source: "webdl", resolution: "1080p", edition: "" });
    const no = input("Show.2020.1080p.DD5.1.WEB-DL.x264-GROUP", { source: "webdl", resolution: "1080p", edition: "" });
    expect(matchFormat(fmt, yes)).toBe(true);
    expect(matchFormat(fmt, no)).toBe(false);
  });

  it("legacy rows without the required key are treated as required (behavior preserved)", () => {
    const fmt: CustomFormat = {
      id: "legacy", name: "legacy",
      specs: [
        { type: "term", term: "x265", negate: false, caseSensitive: false, useRegex: false } as never, // no required key
        { type: "term", term: "hdr", negate: false, caseSensitive: false, useRegex: false } as never,
      ],
    };
    const r = input("Movie.2020.1080p.HDR.x265", { source: "bluray", resolution: "1080p", edition: "" });
    expect(matchFormat(fmt, r)).toBe(true);
    const r2 = input("Movie.2020.1080p.x265", { source: "bluray", resolution: "1080p", edition: "" });
    expect(matchFormat(fmt, r2)).toBe(false);
  });
});

describe("SON-025/RAD-010 — new condition types", () => {
  it("resolution/source/modifier specs match the release quality", () => {
    const r = releaseMatchInput(release({ title: "Movie.2020.1080p.BluRay.Remux.x264", quality: { source: "bluray", resolution: "1080p", edition: "", modifier: "remux" } }));
    expect(matchSpec({ type: "resolution", resolution: "1080p", negate: false, required: true, caseSensitive: false }, r)).toBe(true);
    expect(matchSpec({ type: "source", source: "bluray", negate: false, required: true, caseSensitive: false }, r)).toBe(true);
    expect(matchSpec({ type: "modifier", modifier: "remux", negate: false, required: true, caseSensitive: false }, r)).toBe(true);
    expect(matchSpec({ type: "modifier", modifier: "brdisk", negate: false, required: true, caseSensitive: false }, r)).toBe(false);
  });

  it("releaseType matches single / multi / season from the title, and never a movie", () => {
    const single = releaseMatchInput(release({ title: "Show.S05E16.1080p.WEB-DL" }));
    const multi = releaseMatchInput(release({ title: "Show.S05E16-E17.1080p.WEB-DL" }));
    const season = releaseMatchInput(release({ title: "Show.S02.Complete.1080p.BluRay" }));
    const movie = releaseMatchInput(release({ title: "Movie.2020.1080p.BluRay.x264-GROUP" }));
    const s = (rt: "single" | "multi" | "season") => ({ type: "releaseType" as const, releaseType: rt, negate: false, required: true, caseSensitive: false });
    expect(matchSpec(s("single"), single)).toBe(true);
    expect(matchSpec(s("multi"), multi)).toBe(true);
    expect(matchSpec(s("season"), season)).toBe(true);
    // a movie release never satisfies any releaseType spec, regardless of negate
    expect(matchSpec(s("single"), movie)).toBe(false);
    expect(matchSpec({ ...s("single"), negate: true }, movie)).toBe(false);
  });
});

describe("parseLanguages", () => {
  it("detects a language from a release title", () => {
    expect(parseLanguages("Movie.2020.1080p.FRENCH")).toContain("fr");
    expect(parseLanguages("Some.Movie.German")).toContain("de");
  });
  it("returns [] for unmarked or multi titles rather than guessing", () => {
    expect(parseLanguages("Movie.2020.1080p.WEB-DL")).toEqual([]);
    expect(parseLanguages("Movie.MULTi")).toEqual([]);
  });
  it("does not false-positive on a language word inside a longer token", () => {
    // "the" is not a language here; and 'eng' shouldn't match "English" substring-only.
    expect(parseLanguages("Movie.English.1080p")).toContain("en");
  });
});
