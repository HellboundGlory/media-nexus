// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { decideImportFile, isSample, isIncompleteTransfer, type KnownEpisode } from "./import-decision";
import { qualityId, type Quality, type QualityProfileLike } from "./quality";

const q = (source: string, resolution: string): Quality => ({
  source: source as Quality["source"], resolution: resolution as Quality["resolution"], edition: "",
});

describe("isSample", () => {
  it("flags a sample-token filename or a sample subfolder", () => {
    expect(isSample("/downloads/Show.S02E03.Sample.mkv")).toBe(true);
    expect(isSample("/downloads/Sample/Show.S02E03.mkv")).toBe(true);
    expect(isSample("/downloads/Show-Sample-S02E03.mkv")).toBe(true);
  });

  it("does not flag a normal filename", () => {
    expect(isSample("/downloads/Show.S02E03.1080p.WEB-DL.mkv")).toBe(false);
    expect(isSample("/downloads/Samples.S02E03.mkv")).toBe(false); // not a standalone token
  });
});

describe("isIncompleteTransfer", () => {
  it("flags empty files and known incomplete suffixes", () => {
    expect(isIncompleteTransfer({ path: "/x/a.mkv", size: 0 })).toBe(true);
    expect(isIncompleteTransfer({ path: "/x/a.mkv.part", size: 1000 })).toBe(true);
    expect(isIncompleteTransfer({ path: "/x/a.mkv.!ut", size: 1000 })).toBe(true);
    expect(isIncompleteTransfer({ path: "/x/a.mkv", size: 1000 })).toBe(false);
  });
});

describe("decideImportFile — sample and incomplete", () => {
  it("rejects a sample regardless of episode match", () => {
    const known = new Map<number, KnownEpisode>([[3, { id: "ep3", existingQuality: null }]]);
    const d = decideImportFile({ path: "/x/Show.S02E03.sample.mkv", size: 1000 }, [3], known, q("web", "1080p"), null);
    expect(d.approved).toBe(false);
    expect(d.rejections.map((r) => r.reason)).toContain("sample");
  });

  it("rejects an empty/incomplete file", () => {
    const known = new Map<number, KnownEpisode>([[3, { id: "ep3", existingQuality: null }]]);
    const d = decideImportFile({ path: "/x/Show.S02E03.mkv", size: 0 }, [3], known, q("web", "1080p"), null);
    expect(d.approved).toBe(false);
    expect(d.rejections.map((r) => r.reason)).toContain("incomplete_transfer");
  });
});

describe("decideImportFile — episode matching", () => {
  it("approves and records the episode id for a matched episode", () => {
    const known = new Map<number, KnownEpisode>([[3, { id: "ep3", existingQuality: null }]]);
    const d = decideImportFile({ path: "/x/Show.S02E03.mkv", size: 1000 }, [3], known, q("web", "1080p"), null);
    expect(d.approved).toBe(true);
    expect(d.episodeIds).toEqual(["ep3"]);
  });

  it("rejects a file whose parsed episode isn't part of the known season", () => {
    const known = new Map<number, KnownEpisode>([[3, { id: "ep3", existingQuality: null }]]);
    const d = decideImportFile({ path: "/x/Show.S02E99.mkv", size: 1000 }, [99], known, q("web", "1080p"), null);
    expect(d.approved).toBe(false);
    expect(d.rejections.map((r) => r.reason)).toContain("no_matching_episode");
  });

  it("approves a file with no parseable episode number (caller decides what to do with it)", () => {
    const known = new Map<number, KnownEpisode>();
    const d = decideImportFile({ path: "/x/Show.mkv", size: 1000 }, [], known, q("web", "1080p"), null);
    expect(d.approved).toBe(true);
    expect(d.episodeIds).toEqual([]);
  });
});

describe("decideImportFile — upgrade/cutoff, per matched episode", () => {
  const profile: QualityProfileLike = {
    items: [qualityId(q("hdtv", "720p")), qualityId(q("web", "1080p")), qualityId(q("bluray", "1080p"))],
    cutoffQualityId: qualityId(q("web", "1080p")),
  };

  it("approves when the matched episode has no existing file (wanted/missing)", () => {
    const known = new Map<number, KnownEpisode>([[3, { id: "ep3", existingQuality: null }]]);
    const d = decideImportFile({ path: "/x/Show.S02E03.mkv", size: 1000 }, [3], known, q("web", "1080p"), profile);
    expect(d.approved).toBe(true);
  });

  it("rejects once the matched episode's existing file already meets cutoff", () => {
    const known = new Map<number, KnownEpisode>([[3, { id: "ep3", existingQuality: q("web", "1080p") }]]);
    const d = decideImportFile({ path: "/x/Show.S02E03.mkv", size: 1000 }, [3], known, q("bluray", "1080p"), profile);
    expect(d.approved).toBe(false);
    expect(d.rejections.map((r) => r.reason)).toContain("cutoff_already_met");
  });

  it("rejects a file that isn't actually better than the existing one", () => {
    const known = new Map<number, KnownEpisode>([[3, { id: "ep3", existingQuality: q("hdtv", "720p") }]]);
    const d = decideImportFile({ path: "/x/Show.S02E03.mkv", size: 1000 }, [3], known, q("hdtv", "720p"), profile);
    expect(d.approved).toBe(false);
    expect(d.rejections.map((r) => r.reason)).toContain("not_an_upgrade");
  });

  it("approves a genuine upgrade below cutoff", () => {
    const known = new Map<number, KnownEpisode>([[3, { id: "ep3", existingQuality: q("hdtv", "720p") }]]);
    const d = decideImportFile({ path: "/x/Show.S02E03.mkv", size: 1000 }, [3], known, q("web", "1080p"), profile);
    expect(d.approved).toBe(true);
  });

  it("approves a multi-episode file if at least one covered episode is still missing", () => {
    const known = new Map<number, KnownEpisode>([
      [3, { id: "ep3", existingQuality: q("bluray", "1080p") }], // already at/above cutoff
      [4, { id: "ep4", existingQuality: null }], // missing
    ]);
    const d = decideImportFile({ path: "/x/Show.S02E03-E04.mkv", size: 1000 }, [3, 4], known, q("web", "1080p"), profile);
    expect(d.approved).toBe(true);
    expect(d.episodeIds.sort()).toEqual(["ep3", "ep4"]);
  });
});
