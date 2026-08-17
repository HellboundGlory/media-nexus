// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  QUALITY_REGISTRY, qualityId, compareQuality, qualityAllowed, profilePosition, meetsCutoff,
  qualityProfileSchema, type Quality,
} from "./quality";

const q = (source: string, resolution: string): Quality => ({
  source: source as Quality["source"], resolution: resolution as Quality["resolution"], edition: "",
});

describe("quality registry", () => {
  it("covers every (source, resolution, modifier) combination exactly once", () => {
    const keys = new Set(QUALITY_REGISTRY.map((r) => r.key));
    expect(keys.size).toBe(QUALITY_REGISTRY.length);
    expect(QUALITY_REGISTRY.length).toBe(144); // 8 sources x 6 resolutions x 3 modifiers (RAD-010)
  });

  it("ids are unique and dense from 0", () => {
    const ids = QUALITY_REGISTRY.map((r) => r.id).sort((a, b) => a - b);
    expect(ids).toEqual([...Array(144).keys()]);
  });

  it("resolution dominates the ordering: a 2160p release always outranks a 480p one", () => {
    // this is bug I4 by construction: bluray/480p must NOT outrank web/2160p.
    expect(qualityId(q("bluray", "480p"))).toBeLessThan(qualityId(q("web", "2160p")));
  });

  it("dvd no longer outranks web at the same resolution", () => {
    expect(qualityId(q("dvd", "1080p"))).toBeLessThan(qualityId(q("web", "1080p")));
  });

  it("within a resolution, bluray outranks web outranks hdtv", () => {
    expect(qualityId(q("bluray", "1080p"))).toBeGreaterThan(qualityId(q("web", "1080p")));
    expect(qualityId(q("web", "1080p"))).toBeGreaterThan(qualityId(q("hdtv", "1080p")));
  });

  it("splits webdl / webrip and ranks them below bluray and above hdtv (RAD-010)", () => {
    // upstream enum order: ... DVD < TV < WEBDL < WEBRIP < BLURAY
    expect(qualityId(q("hdtv", "1080p"))).toBeLessThan(qualityId(q("webdl", "1080p")));
    expect(qualityId(q("webdl", "1080p"))).toBeLessThan(qualityId(q("webrip", "1080p")));
    expect(qualityId(q("webrip", "1080p"))).toBeLessThan(qualityId(q("bluray", "1080p")));
  });

  it("modifier ranks within a source: plain < brdisk < remux (RAD-010)", () => {
    expect(qualityId(q("bluray", "1080p"))).toBeLessThan(qualityId({ ...q("bluray", "1080p"), modifier: "brdisk" }));
    expect(qualityId({ ...q("bluray", "1080p"), modifier: "brdisk" })).toBeLessThan(qualityId({ ...q("bluray", "1080p"), modifier: "remux" }));
  });

  it("remux at a resolution outranks plain bluray at the same resolution (the tier-upgrade reading)", () => {
    expect(qualityId(q("bluray", "1080p"))).toBeLessThan(qualityId({ ...q("bluray", "1080p"), modifier: "remux" }));
  });

  it("compareQuality mirrors qualityId ordering", () => {
    expect(compareQuality(q("bluray", "1080p"), q("web", "720p"))).toBeGreaterThan(0);
    expect(compareQuality(q("web", "720p"), q("web", "720p"))).toBe(0);
  });

  it("unknown/unknown falls back cleanly and is the worst quality", () => {
    const unknown = qualityId(q("unknown", "unknown"));
    expect(unknown).toBe(0);
    expect(QUALITY_REGISTRY.every((r) => r.id >= unknown)).toBe(true);
  });
});

describe("quality profile schema", () => {
  it("rejects a cutoff that isn't in items", () => {
    const result = qualityProfileSchema.safeParse({
      name: "Bad", items: [qualityId(q("web", "1080p"))], cutoffQualityId: qualityId(q("bluray", "2160p")),
    });
    expect(result.success).toBe(false);
  });

  it("accepts a cutoff that is in items", () => {
    const result = qualityProfileSchema.safeParse({
      name: "OK", items: [qualityId(q("web", "1080p")), qualityId(q("bluray", "1080p"))], cutoffQualityId: qualityId(q("web", "1080p")),
    });
    expect(result.success).toBe(true);
  });
});

describe("qualityAllowed / profilePosition / meetsCutoff", () => {
  const profile = {
    items: [qualityId(q("hdtv", "720p")), qualityId(q("web", "1080p")), qualityId(q("bluray", "1080p"))],
    cutoffQualityId: qualityId(q("web", "1080p")),
  };

  it("allows only listed qualities", () => {
    expect(qualityAllowed(profile, q("web", "1080p"))).toBe(true);
    expect(qualityAllowed(profile, q("bluray", "2160p"))).toBe(false);
  });

  it("ranks allowed qualities by their position in items", () => {
    expect(profilePosition(profile, q("hdtv", "720p"))).toBe(0);
    expect(profilePosition(profile, q("bluray", "1080p"))).toBe(2);
    expect(profilePosition(profile, q("bluray", "2160p"))).toBe(-1);
  });

  it("meets cutoff at and above the cutoff position, not below it", () => {
    expect(meetsCutoff(profile, q("hdtv", "720p"))).toBe(false); // below cutoff
    expect(meetsCutoff(profile, q("web", "1080p"))).toBe(true);  // at cutoff
    expect(meetsCutoff(profile, q("bluray", "1080p"))).toBe(true); // above cutoff
  });

  it("a disallowed quality never meets cutoff", () => {
    expect(meetsCutoff(profile, q("bluray", "2160p"))).toBe(false);
  });
});
