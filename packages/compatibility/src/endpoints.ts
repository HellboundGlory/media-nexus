// SPDX-License-Identifier: MIT
import type { CompatRoute } from "./types";

/** Explicit 501 for knowingly-missing compat endpoints (fail loudly, not silently). */
export function notImplemented(description: string): CompatRoute["handler"] {
  return async () => ({
    status: 501,
    body: { message: "Not implemented yet in the MediaNexus compatibility layer", feature: description },
  });
}

export const json = (body: unknown, status = 200) => ({ status, body });
