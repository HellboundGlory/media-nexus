// SPDX-License-Identifier: MIT
// `tagApplies` now lives in the pure domain (packages/domain/src/tags.ts) so the decision-engine
// release-profile specs can reuse it without depending on this API layer. Kept here as a thin
// re-export so existing indexer/download-client callers keep a stable import path.
export { tagApplies } from "@medianexus/domain";
