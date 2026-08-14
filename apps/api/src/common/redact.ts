// SPDX-License-Identifier: MIT
/** Mask credential fields before returning config/payloads to clients. */
const SECRET_KEY = /(?:api.?key|apikey|token|secret|password|pass|credential|user|username|chatid)/i;

/** Sentinel value redacted credential fields are replaced with on API output. Consumers
 *  that round-trip a redacted value back (e.g. an edit PATCH) must treat this as
 *  "unchanged — preserve the stored value", never store it literally. */
export const REDACTED = "[REDACTED]";

export function redactDeep(input: unknown, isSecretKey = false): unknown {
  if (Array.isArray(input)) return input.map((x) => redactDeep(x, isSecretKey));
  if (input && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? REDACTED : redactDeep(v, false);
    }
    return out;
  }
  return input;
}

export function redactSettings(input: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  return (redactDeep(input ?? null) as Record<string, unknown> | null) ?? null;
}
