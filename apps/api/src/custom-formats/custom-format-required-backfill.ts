// SPDX-License-Identifier: MIT
/**
 * SON-025 — idempotent backfill of the new `required` field onto existing
 * `custom_format.specs` JSON. `custom_format.specs` is a raw `json<>()` column and the API
 * read path returns it unparsed, so rows saved before `required` existed literally lack
 * the key. The matching algorithm treats an absent key as required anyway, but persisting
 * it keeps the stored data self-consistent and lets the UI render a saved format's
 * `required` checkboxes correctly.
 *
 * Structural idempotency (same as `runSecretBackfill`): adds `required: true` only to a
 * spec that is missing the key; a re-run is a no-op. Runs once after migrations on boot.
 */
import { eq } from "drizzle-orm";
import { schema, type Db } from "@medianexus/database";

export async function runCustomFormatRequiredBackfill(db: Db): Promise<number> {
  const rows = await db.select().from(schema.customFormat);
  let updated = 0;
  for (const row of rows) {
    const specs = (row.specs ?? []) as Record<string, unknown>[];
    let changed = false;
    const next = specs.map((spec) => {
      if (spec && typeof spec === "object" && !("required" in spec)) {
        changed = true;
        return { ...spec, required: true };
      }
      return spec;
    });
    if (changed) {
      await db.update(schema.customFormat)
        .set({ specs: next as never })
        .where(eq(schema.customFormat.id, row.id));
      updated++;
    }
  }
  return updated;
}
