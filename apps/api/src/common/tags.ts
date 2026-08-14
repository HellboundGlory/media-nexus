// SPDX-License-Identifier: MIT
/** A tag-restricted provider (indexer / download client) is eligible for a given item iff
 *  the provider has no tags (applies to everything) or it shares at least one tag with the
 *  item. An item with no tags is served only by untagged providers. (roadmap P2, gap C6). */
export function tagApplies(
  providerTags: string[] | null | undefined,
  mediaTags: string[] | null | undefined,
): boolean {
  const pt = providerTags ?? [];
  if (pt.length === 0) return true; // an untagged provider applies to everything
  return Boolean(mediaTags?.length && pt.some((t) => mediaTags.includes(t)));
}
