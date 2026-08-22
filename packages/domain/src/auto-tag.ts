// SPDX-License-Identifier: MIT
import { z } from "zod";

/**
 * Auto-tagging (roadmap P3, gap report C6): rules that automatically apply/remove tags on
 * movie/series rows based on typed conditions, matching upstream Sonarr/Radarr `AutoTag`.
 *
 * The matching algorithm is a faithful port of upstream `AutoTaggingService.GetTagChanges`
 * (`SpecificationMatchesGroup.DidMatch`):
 *   1. group the rule's specifications BY TYPE (all Genre specs together, all Status specs
 *      together, ...);
 *   2. within each type-group: `DidMatch = !(any Required spec failed) && !(every spec failed)`
 *      — a group where a Required spec failed, or where every spec failed (or which has zero
 *      specs), does not match;
 *   3. `allMatch = every type-group's DidMatch` (AND across groups/types);
 *   4. if allMatch: add every tag in the rule's `tags` the item doesn't already have;
 *      else if `removeTagsAutomatically`: remove every tag in the rule's `tags` (unconditionally,
 *      a no-op removal is harmless); else do nothing.
 *
 * The core algorithm is media-neutral — only which spec *types* match which media kind varies.
 * `network`/`seriesType` are optional/undefined for movies; those specs simply never match a movie
 * (mirroring how sonarr-only spec types are absent from Radarr's spec list).
 *
 * Pure and DB-free: the API layer loads `auto_tag` rows and hands them + the item's field snapshot
 * to `computeTagChanges`. Studio/Runtime/OriginalLanguage (Radarr movie-only) are DEFERRED — the
 * schema doesn't model those fields yet; see HANDOFF for the reasoning.
 */

/** Fields shared by every spec variant. `name` is an optional per-condition label (shown in the
 *  UI next to the condition) — distinct from the rule's own `name`, which lives on `autoTagSchema`. */
const specFlags = {
  name: z.string().optional(),
  negate: z.boolean().default(false),
  required: z.boolean().default(false),
};

export const autoTagSpecSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tag"), value: z.string().min(1), ...specFlags }),
  z.object({ type: z.literal("year"), value: z.number().int(), ...specFlags }),
  z.object({ type: z.literal("genre"), value: z.string().min(1), ...specFlags }),
  z.object({ type: z.literal("status"), value: z.string().min(1), ...specFlags }),
  z.object({ type: z.literal("monitored"), value: z.boolean(), ...specFlags }),
  z.object({ type: z.literal("rootFolder"), value: z.string().min(1), ...specFlags }),
  z.object({ type: z.literal("qualityProfile"), value: z.string().min(1), ...specFlags }),
  z.object({ type: z.literal("network"), value: z.string().min(1), ...specFlags }),
  z.object({ type: z.literal("seriesType"), value: z.string().min(1), ...specFlags }),
]);
export type AutoTagSpec = z.infer<typeof autoTagSpecSchema>;

export const autoTagSchema = z.object({
  name: z.string().min(1),
  removeTagsAutomatically: z.boolean().default(false),
  /** The tag ids this rule manages (applied when it matches, removed when it stops matching and
   *  `removeTagsAutomatically` is set). */
  tags: z.array(z.string()).default([]),
  specifications: z.array(autoTagSpecSchema).default([]),
});
export type AutoTagBody = z.infer<typeof autoTagSchema>;

/** Partial update; missing keys merge from the existing row (empty arrays are real values). */
export const updateAutoTagSchema = autoTagSchema.partial();
export type UpdateAutoTagBody = z.infer<typeof updateAutoTagSchema>;

export interface AutoTag {
  id: string;
  name: string;
  removeTagsAutomatically: boolean;
  tags: string[];
  specifications: AutoTagSpec[];
}

/** The slice of a movie/series row the specs are allowed to look at. Media-neutral fields are
 *  always present; `network`/`seriesType` are set for series and left undefined for movies. */
export interface AutoTagItemInput {
  tags: string[];
  genres: string[];
  status: string | null;
  monitored: boolean;
  rootFolderPath: string;
  qualityProfileId: string | null;
  year: number | null;
  network?: string | null;
  seriesType?: string | null;
}

/** Whether a single spec's raw condition holds for the item (before `negate`). */
function specConditionHolds(spec: AutoTagSpec, item: AutoTagItemInput): boolean {
  switch (spec.type) {
    case "tag": return item.tags.includes(spec.value);
    case "year": return item.year === spec.value;
    case "genre": return item.genres.includes(spec.value);
    case "status": return item.status === spec.value;
    case "monitored": return item.monitored === spec.value;
    case "rootFolder": return item.rootFolderPath === spec.value;
    case "qualityProfile": return item.qualityProfileId === spec.value;
    case "network": return item.network === spec.value;
    case "seriesType": return item.seriesType === spec.value;
  }
}

/** Upstream `AutoTaggingSpecificationBase`: `negate` inverts the spec's own result. */
function specPasses(spec: AutoTagSpec, item: AutoTagItemInput): boolean {
  return spec.negate ? !specConditionHolds(spec, item) : specConditionHolds(spec, item);
}

/** Upstream `AutoTaggingService` group evaluation for one rule. */
export function autoTagRuleMatches(rule: AutoTag, item: AutoTagItemInput): boolean {
  // 1. group by type
  const groups = new Map<string, AutoTagSpec[]>();
  for (const spec of rule.specifications) {
    const list = groups.get(spec.type) ?? [];
    list.push(spec);
    groups.set(spec.type, list);
  }
  // 2+3. each group must DidMatch; AND across groups
  for (const specs of groups.values()) {
    const passes = specs.map((s) => specPasses(s, item));
    const anyRequiredFailed = specs.some((s, i) => s.required && !passes[i]);
    const everyFailed = passes.every((p) => !p);
    if (anyRequiredFailed || everyFailed) return false;
  }
  return true; // vacuous for a rule with no specs, matching upstream
}

/** Upstream `GetTagChanges`: the per-rule add/remove deltas across all rules. */
export function computeTagChanges(
  rules: AutoTag[],
  item: AutoTagItemInput,
): { toAdd: string[]; toRemove: string[] } {
  const toAdd: string[] = [];
  const toRemove: string[] = [];
  for (const rule of rules) {
    const matches = autoTagRuleMatches(rule, item);
    if (matches) {
      for (const t of rule.tags) {
        if (!item.tags.includes(t) && !toAdd.includes(t)) toAdd.push(t);
      }
    } else if (rule.removeTagsAutomatically) {
      for (const t of rule.tags) {
        if (!toRemove.includes(t)) toRemove.push(t);
      }
    }
  }
  return { toAdd, toRemove };
}
