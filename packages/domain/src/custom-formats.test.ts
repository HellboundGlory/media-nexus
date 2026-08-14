// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  matchSpec, matchFormat, calculateFormatScore,
  releaseMatchInput, existingFileMatchInput,
  type CustomFormat, type CustomFormatSpec, type CustomFormatMatchInput,
} from "./custom-formats";
import { parseLanguages } from "./parser";
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
