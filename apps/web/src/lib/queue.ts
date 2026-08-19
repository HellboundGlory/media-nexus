// SPDX-License-Identifier: MIT
// Shared 'active vs terminal' queue-entry judgment (DOWNLOADSBADGE-1). The nav-badge, the
// Dashboard stat, and the Downloads page all must count ONLY active grabs: imported/removed rows
// are resolved and kept server-side for lineage only (torrent seed-goal tracking etc.), so they
// are terminal/non-active and excluded everywhere. One implementation, not three inline copies
// that drift independently (this was the root cause — Downloads filtered but the badge/stat
// didn't).
import type { QueueRow } from "../api/types";

/** Whether a queue row is an active grab (not a terminal imported/removed row). */
export function isActiveQueueEntry(q: Pick<QueueRow, "status">): boolean {
  return q.status !== "imported" && q.status !== "removed";
}

/** Count of active (non-terminal) rows in a queue batch. */
export function activeQueueCount(items: QueueRow[]): number {
  return items.filter(isActiveQueueEntry).length;
}
