// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { evaluate, pickBest, compareDecisions, type DecisionContext } from "./decision";
import type { CustomFormat } from "./custom-formats";
import { matchesTerm, type ReleaseProfile } from "./release-profile";
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
    freeSpaceBytes: null,
    minimumFreeSpaceMb: 100,
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

describe("evaluate — free space", () => {
  it("rejects when the release would leave less than the configured margin free", () => {
    const oneMb = 1024 * 1024;
    const d = evaluate(
      release({ size: 50 * oneMb }),
      baseContext({ freeSpaceBytes: 100 * oneMb, minimumFreeSpaceMb: 100 }),
    );
    expect(d.approved).toBe(false);
    expect(d.rejections.map((r) => r.reason)).toEqual(["insufficient_free_space"]);
  });

  it("approves when free space minus the release still clears the margin", () => {
    const oneMb = 1024 * 1024;
    const d = evaluate(
      release({ size: 50 * oneMb }),
      baseContext({ freeSpaceBytes: 200 * oneMb, minimumFreeSpaceMb: 100 }),
    );
    expect(d.approved).toBe(true);
  });

  it("never blocks when free space could not be determined", () => {
    const d = evaluate(release({ size: 10 ** 12 }), baseContext({ freeSpaceBytes: null, minimumFreeSpaceMb: 100 }));
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

describe("custom-format scoring (roadmap P2)", () => {
  const REMUX_FORMATS: CustomFormat[] = [{
    id: "f1", name: "x265",
    specs: [{ type: "term", term: "x265", useRegex: false, negate: false, caseSensitive: false }],
  }];
  // helper: a format-aware context scoring the "x265" term format at 100
  function fmtCtx(over: Partial<DecisionContext> = {}): DecisionContext {
    return baseContext({ customFormats: REMUX_FORMATS, formatScores: { f1: 100 }, ...over });
  }

  it("computes the release's formatScore and exposes it on the decision", () => {
    const d = evaluate(release({ title: "Movie.2020.1080p.x265" }), fmtCtx());
    expect(d.formatScore).toBe(100);
    const d2 = evaluate(release({ title: "Movie.2020.1080p.WEB-DL" }), fmtCtx());
    expect(d2.formatScore).toBe(0);
  });

  describe("minFormatScore gate", () => {
    it("rejects a release whose format score is below the profile minimum", () => {
      const d = evaluate(release({ title: "Movie.2020.1080p.WEB-DL" }), fmtCtx({ minFormatScore: 50 }));
      expect(d.approved).toBe(false);
      expect(d.rejections.map((r) => r.reason)).toContain("below_min_format_score");
    });
    it("approves a release at or above the minimum", () => {
      const d = evaluate(release({ title: "Movie.2020.1080p.x265" }), fmtCtx({ minFormatScore: 50 }));
      expect(d.approved).toBe(true);
    });
    it("is inert when minFormatScore is 0", () => {
      const d = evaluate(release({ title: "Movie.2020.1080p.WEB-DL" }), fmtCtx({ minFormatScore: 0 }));
      expect(d.approved).toBe(true);
    });
  });

  describe("format score as comparator tiebreaker after quality", () => {
    it("prefers the higher format score at equal quality", () => {
      const ctx = fmtCtx();
      const a = evaluate(release({ id: "a", title: "Movie.2020.1080p.x265", seeders: 5 }), ctx);
      const b = evaluate(release({ id: "b", title: "Movie.2020.1080p.WEB-DL", seeders: 50 }), ctx);
      // b has more seeders but a wins on format score (quality tied)
      expect(compareDecisions(a, b)).toBeGreaterThan(0);
      expect(pickBest([a, b])?.release.id).toBe("a");
    });
  });

  describe("upgrade driven purely by format score", () => {
    it("upgrades a same-quality release with a higher format score, below format cutoff", () => {
      const ctx = fmtCtx({
        profile: { items: [qualityId(q("hdtv", "720p")), qualityId(q("web", "1080p"))], cutoffQualityId: qualityId(q("web", "1080p")) },
        existingFiles: [existingFile(q("hdtv", "720p"))], // name "x.mkv" -> format score 0
      });
      const d = evaluate(release({ title: "Movie.2020.720p.x265", quality: q("hdtv", "720p") }), ctx);
      // same quality as held file, but format score 100 > 0
      expect(d.approved).toBe(true);
    });

    it("upgrades at the SAME quality even when the quality cutoff is already met, if the format cutoff isn't", () => {
      const ctx = fmtCtx({
        profile: {
          items: [qualityId(q("web", "1080p"))], cutoffQualityId: qualityId(q("web", "1080p")),
        },
        cutoffFormatScore: 50, // context-level threshold (as decision.service populates)
        existingFiles: [existingFile(q("web", "1080p"))], // meets quality cutoff, format score 0 < 50
      });
      const d = evaluate(release({ title: "Movie.2020.1080p.x265", quality: q("web", "1080p") }), ctx);
      // quality cutoff met but format cutoff not -> a higher-format same-quality release upgrades
      expect(d.approved).toBe(true);
    });

    it("rejects a lower format score at the same quality when the held file is below cutoff (no upgrade on either axis)", () => {
      const ctx = fmtCtx({
        profile: {
          items: [qualityId(q("hdtv", "720p")), qualityId(q("web", "1080p"))],
          cutoffQualityId: qualityId(q("web", "1080p")),
        },
        existingFiles: [existingFile(q("hdtv", "720p"))], // below quality cutoff, format score 0
      });
      const d = evaluate(release({ title: "Movie.2020.720p.WEB-DL", quality: q("hdtv", "720p") }), ctx);
      expect(d.approved).toBe(false);
      expect(d.rejections.map((r) => r.reason)).toContain("not_an_upgrade");
    });

    it("rejects nothing-on-format-either when the held file already meets both cutoffs", () => {
      // existing file x.mkv meets quality cutoff; format score 0 >= cutoff 0 -> cutoff already met
      const ctx = fmtCtx({
        profile: {
          items: [qualityId(q("web", "1080p"))], cutoffQualityId: qualityId(q("web", "1080p")),
          cutoffFormatScore: 0,
        },
        existingFiles: [existingFile(q("web", "1080p"))],
      });
      const d = evaluate(release({ title: "Movie.2020.1080p.x265", quality: q("web", "1080p") }), ctx);
      expect(d.approved).toBe(false);
      expect(d.rejections.map((r) => r.reason)).toContain("cutoff_already_met");
    });
  });
});

describe("matchesTerm (release-profile term syntax, Sonarr TermMatcherService)", () => {
  it("matches a plain substring case-insensitively", () => {
    expect(matchesTerm("x265", "Movie.2020.1080p.X265")).toBe(true);
    expect(matchesTerm("REMUX", "movie.remux.2020")).toBe(true);
  });
  it("does not match a substring that isn't present", () => {
    expect(matchesTerm("hdr", "Movie.2020.1080p")).toBe(false);
  });
  it("treats a /term/ bracketed term as a case-insensitive regex", () => {
    expect(matchesTerm("/^The/", "The Movie")).toBe(true);
    expect(matchesTerm("/1080p$/", "Movie.1080p")).toBe(true);
  });
  it("a regex that shouldn't match returns false", () => {
    expect(matchesTerm("/^The/", "Movie.The")).toBe(false);
  });
  it("honours flags supplied inside the bracketed term", () => {
    expect(matchesTerm("/MOVIE/i", "the movie")).toBe(true);
    expect(matchesTerm("/THE/i", "the complete movie")).toBe(true);
  });
  it("a malformed regex never matches rather than throwing", () => {
    expect(matchesTerm("/[unclosed/", "anything")).toBe(false);
  });
});

describe("evaluate — release profiles (roadmap P3, gap C6)", () => {
  const prof = (over: Partial<ReleaseProfile> = {}): ReleaseProfile => ({
    id: "rp1", name: "P", enabled: true, required: [], ignored: [], tags: [], ...over,
  });

  it("rejects a release that matches none of an applicable profile's required terms", () => {
    const d = evaluate(release({ title: "Movie.2020.1080p.WEB-DL" }), baseContext({
      releaseProfiles: [prof({ required: ["x265"] })],
    }));
    expect(d.approved).toBe(false);
    expect(d.rejections.map((r) => r.reason)).toContain("required_term_missing");
  });

  it("approves a release matching at least one required term", () => {
    const d = evaluate(release({ title: "Movie.2020.1080p.x265" }), baseContext({
      releaseProfiles: [prof({ required: ["x265"] })],
    }));
    expect(d.approved).toBe(true);
  });

  it("rejects a release matching an applicable profile's ignored term", () => {
    const d = evaluate(release({ title: "Movie.2020.480p.WEB-DL" }), baseContext({
      releaseProfiles: [prof({ ignored: ["/480p/"] })],
    }));
    expect(d.approved).toBe(false);
    expect(d.rejections.map((r) => r.reason)).toContain("ignored_term_present");
  });

  it("is unaffected by a profile whose tags don't overlap the media's tags", () => {
    const d = evaluate(release({ title: "Movie.2020.480p" }), baseContext({
      releaseProfiles: [prof({ tags: ["4k"], ignored: ["480p"] })],
      mediaTags: ["hdr"], // profile tagged 4k; media has hdr -> not applicable
    }));
    expect(d.approved).toBe(true);
  });

  it("applies a profile that shares the media's tags", () => {
    const d = evaluate(release({ title: "Movie.2020.480p" }), baseContext({
      releaseProfiles: [prof({ tags: ["4k"], ignored: ["480p"] })],
      mediaTags: ["4k"],
    }));
    expect(d.approved).toBe(false);
    expect(d.rejections.map((r) => r.reason)).toContain("ignored_term_present");
  });

  it("requires EACH applicable profile to be satisfied independently", () => {
    const d = evaluate(release({ title: "Movie.2020.1080p.x265" }), baseContext({
      releaseProfiles: [
        prof({ id: "a", name: "A", required: ["x265"] }),             // satisfied
        prof({ id: "b", name: "B", required: ["/\\bremux\\b/"] }),    // not satisfied -> reject
      ],
    }));
    expect(d.approved).toBe(false);
    expect(d.rejections.map((r) => r.reason)).toContain("required_term_missing");
  });

  it("leaves releases unaffected when no profiles are configured", () => {
    const d = evaluate(release({ title: "Anything.480p" }), baseContext());
    expect(d.approved).toBe(true);
  });
});
