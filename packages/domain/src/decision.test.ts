// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { evaluate, pickBest, compareDecisions, type DecisionContext } from "./decision";
import { qualityId, type QualityProfileLike, type Quality } from "./quality";
import { movieTarget } from "./media";
import type { Release } from "./release";
import type { ExistingFile } from "./media";

const q = (source: string, resolution: string): Quality => ({
  source: source as Quality["source"], resolution: resolution as Quality["resolution"], edition: "",
});

function release(over: Partial<Release> = {}): Release {
  return {
    id: "r1", indexerId: "idx1", indexerName: "Demo", title: "Movie.2020.1080p.WEB-DL",
    protocol: "torrent", categories: [], size: 1000, ageHours: 1, seeders: 10, leechers: 1,
    quality: q("web", "1080p"),
    isFreeleech: false, isProper: false, isRepack: false,
    ...over,
  };
}

function baseContext(over: Partial<DecisionContext> = {}): DecisionContext {
  return {
    target: movieTarget("m1"),
    profile: null,
    existingFiles: [],
    isBlocklisted: false,
    hasActiveQueueConflict: false,
    preferredProtocol: "any",
    ...over,
  };
}

const profile: QualityProfileLike = {
  items: [qualityId(q("hdtv", "720p")), qualityId(q("web", "1080p")), qualityId(q("bluray", "1080p"))],
  cutoffQualityId: qualityId(q("web", "1080p")),
};

function existingFile(quality: Quality): ExistingFile {
  return { id: "mf1", relativePath: "x.mkv", size: 1000, quality, episodeIds: [], dateAdded: "2020-01-01" };
}

describe("evaluate — no restrictions", () => {
  it("approves a release when nothing rejects it", () => {
    const d = evaluate(release(), baseContext());
    expect(d.approved).toBe(true);
    expect(d.rejections).toEqual([]);
  });
});

describe("evaluate — profile-allowed", () => {
  it("rejects a quality the profile doesn't list", () => {
    const d = evaluate(release({ quality: q("bluray", "2160p") }), baseContext({ profile }));
    expect(d.approved).toBe(false);
    expect(d.rejections.map((r) => r.reason)).toContain("not_allowed_by_profile");
  });

  it("approves a quality the profile lists", () => {
    const d = evaluate(release({ quality: q("web", "1080p") }), baseContext({ profile }));
    expect(d.approved).toBe(true);
  });

  it("is unrestricted when no profile is assigned (matches pre-engine behaviour)", () => {
    const d = evaluate(release({ quality: q("sd", "480p") }), baseContext({ profile: null }));
    expect(d.approved).toBe(true);
  });
});

describe("evaluate — upgrade / cutoff", () => {
  it("rejects when the existing file already meets the profile's cutoff", () => {
    const ctx = baseContext({ profile, existingFiles: [existingFile(q("web", "1080p"))] });
    // even a better-quality release is rejected once cutoff is already met
    const d = evaluate(release({ quality: q("bluray", "1080p") }), ctx);
    expect(d.approved).toBe(false);
    expect(d.rejections.map((r) => r.reason)).toContain("cutoff_already_met");
  });

  it("rejects a release that is not actually better than the existing file", () => {
    const ctx = baseContext({
      profile: { items: [qualityId(q("hdtv", "720p")), qualityId(q("bluray", "2160p"))], cutoffQualityId: qualityId(q("bluray", "2160p")) },
      existingFiles: [existingFile(q("hdtv", "720p"))],
    });
    const d = evaluate(release({ quality: q("hdtv", "720p") }), ctx);
    expect(d.approved).toBe(false);
    expect(d.rejections.map((r) => r.reason)).toContain("not_an_upgrade");
  });

  it("approves a genuine upgrade below cutoff", () => {
    const ctx = baseContext({
      profile: {
        items: [qualityId(q("hdtv", "720p")), qualityId(q("web", "1080p")), qualityId(q("bluray", "2160p"))],
        cutoffQualityId: qualityId(q("bluray", "2160p")),
      },
      existingFiles: [existingFile(q("hdtv", "720p"))],
    });
    const d = evaluate(release({ quality: q("web", "1080p") }), ctx);
    expect(d.approved).toBe(true);
  });

  it("approves anything when there is no existing file (wanted/missing)", () => {
    const d = evaluate(release({ quality: q("sd", "480p") }), baseContext({ profile, existingFiles: [] }));
    // not allowed by profile in this case, but not rejected FOR the upgrade reason
    expect(d.rejections.map((r) => r.reason)).not.toContain("cutoff_already_met");
    expect(d.rejections.map((r) => r.reason)).not.toContain("not_an_upgrade");
  });
});

describe("evaluate — blocklist and queue conflict", () => {
  it("rejects a blocklisted release", () => {
    const d = evaluate(release(), baseContext({ isBlocklisted: true }));
    expect(d.approved).toBe(false);
    expect(d.rejections.map((r) => r.reason)).toEqual(["blocklisted"]);
  });

  it("rejects when there's an active queue conflict", () => {
    const d = evaluate(release(), baseContext({ hasActiveQueueConflict: true }));
    expect(d.approved).toBe(false);
    expect(d.rejections.map((r) => r.reason)).toEqual(["queue_conflict"]);
  });

  it("can carry multiple rejection reasons at once", () => {
    const d = evaluate(release(), baseContext({ isBlocklisted: true, hasActiveQueueConflict: true }));
    expect(d.rejections.map((r) => r.reason).sort()).toEqual(["blocklisted", "queue_conflict"]);
  });
});

describe("evaluate — protocol preference", () => {
  it("rejects a torrent when usenet is preferred", () => {
    const d = evaluate(release({ protocol: "torrent" }), baseContext({ preferredProtocol: "usenet" }));
    expect(d.approved).toBe(false);
    expect(d.rejections.map((r) => r.reason)).toContain("wrong_protocol");
  });

  it("does not restrict protocol when preference is 'any'", () => {
    const d = evaluate(release({ protocol: "usenet" }), baseContext({ preferredProtocol: "any" }));
    expect(d.approved).toBe(true);
  });
});

describe("pickBest / compareDecisions", () => {
  it("picks the best approved release when the top-quality candidate is rejected", () => {
    const ctx = baseContext({ profile });
    const decisions = [
      evaluate(release({ id: "high", quality: q("bluray", "2160p") }), ctx), // not in profile.items -> rejected
      evaluate(release({ id: "low", quality: q("hdtv", "720p") }), ctx),     // allowed
      evaluate(release({ id: "mid", quality: q("web", "1080p") }), ctx),     // allowed, better than "low"
    ];
    const best = pickBest(decisions);
    expect(best?.release.id).toBe("mid");
  });

  it("returns null when nothing was approved", () => {
    const ctx = baseContext({ isBlocklisted: true });
    const decisions = [evaluate(release(), ctx)];
    expect(pickBest(decisions)).toBeNull();
  });

  it("breaks quality ties on seeders, then freshness", () => {
    const ctx = baseContext();
    const a = evaluate(release({ id: "a", seeders: 5, ageHours: 10 }), ctx);
    const b = evaluate(release({ id: "b", seeders: 50, ageHours: 10 }), ctx);
    expect(compareDecisions(b, a)).toBeGreaterThan(0);

    const c = evaluate(release({ id: "c", seeders: 5, ageHours: 1 }), ctx); // newer
    expect(compareDecisions(c, a)).toBeGreaterThan(0);
  });
});
