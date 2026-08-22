// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  computeTagChanges, autoTagRuleMatches, autoTagSpecSchema, type AutoTag, type AutoTagItemInput,
} from "./auto-tag";

const item = (over: Partial<AutoTagItemInput> = {}): AutoTagItemInput => ({
  tags: [], genres: [], status: null, monitored: true, rootFolderPath: "",
  qualityProfileId: null, year: null, ...over,
});

const rule = (over: Partial<AutoTag> = {}): AutoTag => ({
  id: "r1", name: "R", removeTagsAutomatically: false, tags: ["t1"], specifications: [], ...over,
});

describe("computeTagChanges — match applies tags, non-match respects remove flag", () => {
  it("adds the rule's tags when it matches", () => {
    const r = rule({ specifications: [{ type: "genre", value: "Comedy", negate: false, required: false }], tags: ["comedy-tag"] });
    const changes = computeTagChanges([r], item({ genres: ["Comedy"] }));
    expect(changes).toEqual({ toAdd: ["comedy-tag"], toRemove: [] });
  });

  it("does not re-add a tag the item already has", () => {
    const r = rule({ specifications: [{ type: "genre", value: "Comedy", negate: false, required: false }], tags: ["t1"] });
    const changes = computeTagChanges([r], item({ tags: ["t1"], genres: ["Comedy"] }));
    expect(changes.toAdd).toEqual([]);
  });

  it("removes the rule's tags when the rule stops matching and removeTagsAutomatically is on", () => {
    const r = rule({ removeTagsAutomatically: true, specifications: [{ type: "genre", value: "Comedy", negate: false, required: false }], tags: ["t1"] });
    const changes = computeTagChanges([r], item({ tags: ["t1"], genres: ["Drama"] }));
    expect(changes).toEqual({ toAdd: [], toRemove: ["t1"] });
  });

  it("leaves tags untouched when the rule stops matching but removeTagsAutomatically is off", () => {
    const r = rule({ removeTagsAutomatically: false, specifications: [{ type: "genre", value: "Comedy", negate: false, required: false }], tags: ["t1"] });
    const changes = computeTagChanges([r], item({ tags: ["t1"], genres: ["Drama"] }));
    expect(changes).toEqual({ toAdd: [], toRemove: [] });
  });
});

describe("computeTagChanges — Required gating and grouping", () => {
  it("a Required spec failing fails its whole type-group even if another group passes", () => {
    const r = rule({
      specifications: [
        { type: "genre", value: "Comedy", negate: false, required: true },
        { type: "genre", value: "Drama", negate: false, required: false },
        { type: "status", value: "released", negate: false, required: false },
      ],
    });
    // genres: Drama, status: released -> status group passes, but the genre group's REQUIRED
    // Comedy spec failed (despite the non-required Drama spec passing) -> rule does not match.
    const changes = computeTagChanges([r], item({ genres: ["Drama"], status: "released" }));
    expect(changes.toAdd).toEqual([]);
  });

  it("same-type specs group together (OR within group, AND across groups)", () => {
    // two genre specs: matches when EITHER genre is present (OR within the genre group)
    const orRule = rule({ specifications: [
      { type: "genre", value: "Comedy", negate: false, required: false },
      { type: "genre", value: "Action", negate: false, required: false },
    ] });
    expect(autoTagRuleMatches(orRule, item({ genres: ["Action"] }))).toBe(true);

    // ...but a second type-group (status) must ALSO match (AND across groups)
    const andRule = rule({ specifications: [
      { type: "genre", value: "Comedy", negate: false, required: false },
      { type: "genre", value: "Action", negate: false, required: false },
      { type: "status", value: "released", negate: false, required: false },
    ] });
    expect(autoTagRuleMatches(andRule, item({ genres: ["Action"], status: "continuing" }))).toBe(false);
  });
});

describe("computeTagChanges — negate", () => {
  it("a negated spec inverts its own result", () => {
    // negate genre=Comedy => matches when the item does NOT have Comedy
    const r = rule({ specifications: [{ type: "genre", value: "Comedy", negate: true, required: false }], tags: ["no-comedy"] });
    expect(autoTagRuleMatches(r, item({ genres: ["Drama"] }))).toBe(true);
    expect(autoTagRuleMatches(r, item({ genres: ["Comedy"] }))).toBe(false);
    const changes = computeTagChanges([r], item({ genres: ["Drama"] }));
    expect(changes.toAdd).toEqual(["no-comedy"]);
  });
});

describe("autoTagSpecSchema — optional per-condition name", () => {
  it("preserves a provided per-condition name alongside negate/required", () => {
    const spec = autoTagSpecSchema.parse({ type: "genre", value: "Comedy", name: "Not comedy", negate: true, required: false });
    expect(spec.name).toBe("Not comedy");
    expect(spec.negate).toBe(true);
  });

  it("still accepts specs without a name (rows persisted before the field existed)", () => {
    const spec = autoTagSpecSchema.parse({ type: "genre", value: "Comedy" });
    expect(spec.name).toBeUndefined();
    expect(spec.negate).toBe(false);
    expect(spec.required).toBe(false);
  });
});

describe("computeTagChanges — series-only specs never match a movie", () => {
  it("a network spec never matches when the item has no network field", () => {
    const r = rule({ specifications: [{ type: "network", value: "HBO", negate: false, required: false }] });
    expect(autoTagRuleMatches(r, item({ network: undefined }))).toBe(false);
    expect(autoTagRuleMatches(r, item({ network: "HBO" }))).toBe(true);
  });
});
