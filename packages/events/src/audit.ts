// SPDX-License-Identifier: MIT

/** Well-known audit-level event actions (subscribes the audit listener). */
export const AUDIT_EVENT_TYPES: ReadonlySet<string> = new Set([
  "media.movie.added",
  "media.series.added",
  "media.movie.removed",
  "media.series.removed",
  "requests.request.created",
  "requests.request.approved",
  "requests.request.declined",
  "system.job.manual",
]);
