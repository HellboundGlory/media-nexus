// SPDX-License-Identifier: MIT
/** A tag-restricted provider (indexer / download client) — or, by extension, any tag-scoped
 *  artifact such as a release profile — applies to a given media item iff the scoped set has no
 *  tags (applies to everything) or it shares at least one tag with the item. An item with no tags
 *  is served only by untagged scopes. (roadmap P2, gap C6.) Lives in the pure domain so decision
 *  specifications (release profiles) can use it without depending on the API layer. */
export function tagApplies(
  scopeTags: string[] | null | undefined,
  mediaTags: string[] | null | undefined,
): boolean {
  const st = scopeTags ?? [];
  if (st.length === 0) return true; // an untagged scope applies to everything
  return Boolean(mediaTags?.length && st.some((t) => mediaTags.includes(t)));
}
