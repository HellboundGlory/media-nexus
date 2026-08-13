// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { qualitySourceSchema } from "./quality";
import { releaseSchema } from "./release";

// Quality registry / profile / comparator tests live in quality.test.ts.
describe("domain quality", () => {
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
