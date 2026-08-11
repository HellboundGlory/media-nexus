// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { qualityRank, qualitySatisfies, qualitySourceSchema, type Quality } from "./quality";
import { releaseSchema } from "./release";

const q = (source: string, resolution: string): Quality => ({ source: source as Quality["source"], resolution: resolution as Quality["resolution"], edition: "" });

describe("domain quality", () => {
  it("ranks Blu-ray 1080p above Web 720p", () => {
    expect(qualityRank(q("bluray", "1080p"))).toBeGreaterThan(qualityRank(q("web", "720p")));
  });

  it("profile satisfaction is exact-match on source+resolution", () => {
    const profile = { allowed: [q("web", "1080p")] };
    expect(qualitySatisfies(profile, q("web", "1080p"))).toBe(true);
    expect(qualitySatisfies(profile, q("bluray", "1080p"))).toBe(false);
  });

  it("narrow source enums reject unknown values", () => {
    expect(qualitySourceSchema.safeParse("hd-dvd").success).toBe(false);
    expect(qualitySourceSchema.safeParse("bluray").success).toBe(true);
  });
});

describe("domain schemas", () => {
  it("validates a normalized release", () => {
    const r = releaseSchema.safeParse({
      id: "r1", indexerId: "i1", indexerName: "Demo", title: "T", protocol: "torrent",
      categories: [2000], size: 1, ageHours: 1, seeders: 10,
      quality: { source: "web", resolution: "1080p" },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.isProper).toBe(false);
  });
});
