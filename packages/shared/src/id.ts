// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";

/** Correlation/request ID generator (RFC 4122 v4). */
export function newRequestId(): string {
  return randomUUID();
}

/** Stable short id with a domain prefix, e.g. `movie_01JX9...`. */
export function newEntityId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function newUuid(): string {
  return randomUUID();
}
