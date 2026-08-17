// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  customFormatToUpstream, upstreamToCustomFormat, upstreamSpecToCustom,
  type UpstreamCustomFormat,
} from "./custom-format-io";
import { matchFormat, releaseMatchInput, type CustomFormat, type CustomFormatSpec } from "./custom-formats";
import type { Release } from "./release";

const release = (title: string, quality: Release["quality"]): Release => ({
  id: "r", indexerId: "i", indexerName: "n", title, protocol: "torrent", categories: [], size: 1e9,
  ageHours: 1, seeders: 1, isFreeleech: false, isProper: false, isRepack: false, quality,
});

describe("custom-format import/export mapper (UNI-025)", () => {
  it("round-trips every supported spec type through the upstream shape", () => {
    const specs: CustomFormatSpec[] = [
      { type: "term", term: "x265", useRegex: true, negate: false, required: true },
      { type: "term", term: "REMUX", negate: true, required: true },
      { type: "size", min: 10, max: 20, negate: false, required: true },
      { type: "language", language: "en", negate: true, required: false },
      { type: "source", source: "webdl", negate: false, required: false },
      { type: "source", source: "webrip", negate: false, required: false },
      { type: "resolution", resolution: "720p", negate: false, required: true },
      { type: "modifier", modifier: "remux", negate: true, required: true },
      { type: "releaseGroup", releaseGroup: "DON", negate: false, required: false },
      { type: "releaseType", releaseType: "season", negate: false, required: true },
    ];
    const upstream = customFormatToUpstream(specs);
    const back = upstreamToCustomFormat({ name: "X", specifications: upstream });
    expect(back.skipped).toEqual([]);
    expect(back.specs.length).toBe(specs.length);
    // Round-trip invariant: re-exporting the mapped specs reproduces the same upstream shape.
    expect(customFormatToUpstream(back.specs)).toEqual(upstream);
  });

  it("accepts-and-ignores includeCustomFormatWhenRenaming", () => {
    const parsed = upstreamToCustomFormat({
      name: "X", includeCustomFormatWhenRenaming: true,
      specifications: [{ implementation: "ReleaseTitleSpecification", fields: { value: "x265" } }],
    });
    expect(parsed.name).toBe("X");
    expect(parsed.specs[0]).toMatchObject({ type: "term", term: "x265", negate: false, required: true });
  });

  it("reports an unsupported implementation clearly, importing the supported ones", () => {
    const parsed = upstreamToCustomFormat({
      name: "Mixed",
      specifications: [
        { implementation: "ReleaseTitleSpecification", fields: { value: "x265" } },
        { implementation: "IndexerFlagSpecification", fields: { value: 1 } },
        { implementation: "EditionSpecification", fields: { value: "4K77" } },
      ],
    });
    expect(parsed.specs).toHaveLength(1);
    expect(parsed.skipped.map((s) => s.implementation)).toEqual(["IndexerFlagSpecification", "EditionSpecification"]);
    expect(parsed.skipped[0].reason).toMatch(/unsupported/);
  });

  it("skips a modifier value we don't model (regional/screener/rawhd)", () => {
    const parsed = upstreamToCustomFormat({
      name: "M",
      specifications: [{ implementation: "QualityModifierSpecification", fields: { value: 1 } }], // REGIONAL
    });
    expect(parsed.specs).toHaveLength(0);
    expect(parsed.skipped[0].reason).toMatch(/unsupported quality modifier/);
  });

  it("maps the real '720p Quality Tier 1' body to the intended internals and matches correctly", () => {
    const DON = "(?<=^|[\\s.-])DON\\b";
    const REBORN = "(?<=^|[\\s.-])REBORN\\b";
    const body: UpstreamCustomFormat = {
      name: "720p Quality Tier 1",
      specifications: [
        { implementation: "ResolutionSpecification", required: true, fields: { value: 720 } },       // literal pixel height
        { implementation: "ReleaseTitleSpecification", required: true, negate: true, fields: { value: "Remux" } }, // NOT Remux
        { implementation: "SourceSpecification", required: false, fields: { value: 9 } },            // Bluray
        { implementation: "SourceSpecification", required: false, fields: { value: 8 } },            // WEBRip
        { implementation: "ReleaseGroupSpecification", required: false, fields: { value: DON } },
        { implementation: "ReleaseGroupSpecification", required: false, fields: { value: REBORN } },
      ],
    };
    const parsed = upstreamToCustomFormat(body);
    expect(parsed.skipped).toEqual([]);
    expect(parsed.specs[0]).toMatchObject({ type: "resolution", resolution: "720p", required: true });
    const fmt: CustomFormat = { id: "t1", name: parsed.name, specs: parsed.specs };

    // A release whose parsed group is "DON" matches via the imported regex release-group conditions.
    const match1 = releaseMatchInput(release("Show.S01E01.720p.BluRay.x264-DON", { source: "bluray", resolution: "720p", edition: "" }));
    const match2 = releaseMatchInput(release("Show.S01E01.720p.WEBRip.x264-REBORN", { source: "webrip", resolution: "720p", edition: "" }));
    const noGroup = releaseMatchInput(release("Show.S01E01.720p.BluRay.x264-NOTINLIST", { source: "bluray", resolution: "720p", edition: "" }));
    expect(matchFormat(fmt, match1)).toBe(true);
    expect(matchFormat(fmt, match2)).toBe(true);
    expect(matchFormat(fmt, noGroup)).toBe(false);
  });

  it("imports the real 'AAC' all-required regex shape and it behaves as plain AND", () => {
    const body: UpstreamCustomFormat = {
      name: "AAC",
      specifications: [
        { implementation: "ReleaseTitleSpecification", required: true, negate: false, fields: { value: "\\bAAC(\\b|\\d)" } },
        { implementation: "ReleaseTitleSpecification", required: true, negate: false, fields: { value: "1080p" } },
      ],
    };
    const parsed = upstreamToCustomFormat(body);
    // Imported ReleaseTitle specs are always regex (upstream has no substring mode).
    expect(parsed.specs[0]).toMatchObject({ type: "term", useRegex: true });
    const fmt: CustomFormat = { id: "aac", name: "AAC", specs: parsed.specs };
    const yes = releaseMatchInput(release("Show.2020.1080p.AAC.WEB-DL.x264-GROUP", { source: "webdl", resolution: "1080p", edition: "" }));
    const no = releaseMatchInput(release("Show.2020.1080p.DD5.1.WEB-DL.x264-GROUP", { source: "webdl", resolution: "1080p", edition: "" }));
    expect(parsed.skipped).toEqual([]);
    expect(matchFormat(fmt, yes)).toBe(true);
    expect(matchFormat(fmt, no)).toBe(false);
  });

  it("defaults required=true for specs that omit it (upstream/legacy behavior)", () => {
    const parsed = upstreamSpecToCustom({ implementation: "ReleaseTitleSpecification", fields: { value: "x265" } });
    expect(parsed.spec?.required).toBe(true);
  });
});
