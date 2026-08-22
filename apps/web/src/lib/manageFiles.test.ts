// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { distributeEpisodes, qualityRegistryTitle } from "./manageFiles";
import type { ManageEpisodeRef, QualityRegistryItem } from "../api/types";

function ep(n: number): ManageEpisodeRef {
  return { id: `ep${n}`, seasonNumber: 5, episodeNumber: n, title: `Episode ${n}`, airDateUtc: null };
}

describe("distributeEpisodes — cross-file episode distribution (MANAGEFILES-1)", () => {
  it("assigns one episode per file when counts match", () => {
    const slices = distributeEpisodes([ep(1), ep(2), ep(3)], 3);
    expect(slices).toEqual([[ep(1)], [ep(2)], [ep(3)]]);
  });

  it("slices sequentially in table order, N per file", () => {
    const slices = distributeEpisodes([ep(1), ep(2), ep(3), ep(4)], 2);
    expect(slices).toEqual([[ep(1), ep(2)], [ep(3), ep(4)]]);
  });

  it("sorts by episode number before slicing (pick order is not table order)", () => {
    const slices = distributeEpisodes([ep(4), ep(1), ep(3), ep(2)], 2);
    expect(slices).toEqual([[ep(1), ep(2)], [ep(3), ep(4)]]);
  });

  it("returns [] when the selection does not divide evenly (exact-even-split requirement)", () => {
    expect(distributeEpisodes([ep(1), ep(2), ep(3)], 2)).toEqual([]);
    expect(distributeEpisodes([ep(1)], 0)).toEqual([]);
  });

  it("handles a multi-episode file in a mixed selection", () => {
    const slices = distributeEpisodes([ep(1), ep(2), ep(3), ep(4), ep(5), ep(6)], 3);
    expect(slices).toEqual([[ep(1), ep(2)], [ep(3), ep(4)], [ep(5), ep(6)]]);
  });
});

const REGISTRY: QualityRegistryItem[] = [
  { id: 0, key: "unknown:unknown:none", title: "Unknown", source: "unknown", resolution: "unknown", modifier: "none" },
  { id: 1, key: "bluray:1080p:none", title: "Bluray 1080p", source: "bluray", resolution: "1080p", modifier: "none" },
  { id: 2, key: "bluray:1080p:remux", title: "Bluray 1080p Remux", source: "bluray", resolution: "1080p", modifier: "remux" },
  { id: 3, key: "webdl:2160p:none", title: "WEBDL 2160p", source: "webdl", resolution: "2160p", modifier: "none" },
];

describe("qualityRegistryTitle — canonical registry display titles (MANAGEFILES-1)", () => {
  it("uses the exact registry key including the modifier", () => {
    expect(qualityRegistryTitle({ source: "bluray", resolution: "1080p", modifier: "remux" }, REGISTRY)).toBe("Bluray 1080p Remux");
    expect(qualityRegistryTitle({ source: "bluray", resolution: "1080p", edition: "" }, REGISTRY)).toBe("Bluray 1080p");
  });

  it("falls back through modifier-less, then raw concatenation, never producing the wrong-looking label", () => {
    expect(qualityRegistryTitle({ source: "webdl", resolution: "2160p" }, REGISTRY)).toBe("WEBDL 2160p");
    expect(qualityRegistryTitle({ source: "hdtv", resolution: "720p" }, REGISTRY)).toBe("hdtv · 720p");
    expect(qualityRegistryTitle(null, REGISTRY)).toBe("Unknown");
  });
});