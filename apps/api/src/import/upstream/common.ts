// SPDX-License-Identifier: MIT
/** Shared mappers for quality profiles, indexers and history (used across importers). */
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@medianexus/database";
import { qualityId } from "@medianexus/domain";
import type { SourceDb, ImportRow } from "../importer.types";
import { str, num, bool, jsonc } from "../rows";

const iso = () => new Date().toISOString();

// Upstream's per-profile allowed-quality list isn't mapped item-by-item (that would need
// walking QualityProfile.Items' JSON, which varies by Sonarr/Radarr schema version); every
// imported profile gets a single placeholder quality instead, same simplification as before
// this migration. Users can broaden it via the native quality-profiles CRUD after import.
const PLACEHOLDER_QUALITY_ID = qualityId({ source: "web", resolution: "1080p", edition: "" });

/** Import quality profiles (derived ids -> idempotent). */
export async function importQualityProfiles(
  source: SourceDb, target: Db, table = "QualityProfiles", idPrefix = "q",
): Promise<{ count: number; skipped: number }> {
  let count = 0; let skipped = 0;
  for (const r of source.all(table)) {
    const id = num(r, "Id");
    if (id == null) continue;
    const derivedId = `imp_${idPrefix}${id}`;
    const exists = await target.select().from(schema.qualityProfile).where(eq(schema.qualityProfile.id, derivedId)).limit(1);
    if (exists[0]) { skipped++; continue; }
    await target.insert(schema.qualityProfile).values({
      id: derivedId,
      name: str(r, "Name") ?? `Profile ${id}`,
      items: [PLACEHOLDER_QUALITY_ID],
      cutoffQualityId: PLACEHOLDER_QUALITY_ID,
      upgradeAllowed: bool(r, "UpgradeAllowed", true),
      isDefault: count === 0,
      language: "en",
      createdAt: iso(), updatedAt: iso(),
    }).onConflictDoNothing();
    count++;
  }
  return { count, skipped };
}

/** Import indexer rows (Prowlarr/Sonarr/Radarr `Indexers`). */
export async function importIndexers(
  source: SourceDb, target: Db, table = "Indexers", idPrefix = "idx",
): Promise<{ count: number; skipped: number; unknownSettings: number }> {
  let count = 0; let skipped = 0; let unknownSettings = 0;
  for (const r of source.all(table)) {
    const id = num(r, "Id");
    if (id == null) continue;
    const derivedId = `imp_${idPrefix}${id}`;
    const exists = await target.select().from(schema.indexer).where(eq(schema.indexer.id, derivedId)).limit(1);
    if (exists[0]) { skipped++; continue; }
    let settings = jsonc<Record<string, unknown>>(r, "Settings", {});
    if (!settings || typeof settings !== "object" || !Object.keys(settings).length) {
      settings = { baseUrl: "https://example.invalid" };
      unknownSettings++;
    }
    const protocolRaw = str(r, "Protocol");
    await target.insert(schema.indexer).values({
      id: derivedId,
      definitionKey: str(r, "DefinitionName") ?? str(r, "Implementation") ?? "generic-newznab",
      name: str(r, "Name") ?? `Indexer ${id}`,
      protocol: (String(protocolRaw ?? "usenet").toLowerCase() === "torrent" ? "torrent" : "usenet"),
      enabled: bool(r, "Enable", true),
      implementation: str(r, "Implementation") ?? "newznab",
      settings,
      proxy: null,
      priority: num(r, "Priority") ?? 25,
      status: "ok",
      tags: jsonc<unknown[]>(r, "Tags", []).map(String),
      createdAt: iso(), updatedAt: iso(),
    }).onConflictDoNothing();
    count++;
  }
  return { count, skipped, unknownSettings };
}

/** Map an upstream History EventType int to a unified action. */
export function mapHistoryAction(et: number | undefined): string {
  switch (et) {
    case 1: return "grabbed";
    case 2: case 3: case 13: return "import_completed";
    case 5: return "download_failed";
    default: return "unknown";
  }
}

export async function importHistory(
  source: SourceDb, target: Db, table: string, idPrefix: string,
  media: { mediaType: "movie" | "series"; mediaIdOf: (r: ImportRow) => string | undefined },
): Promise<{ count: number; skipped: number }> {
  let count = 0; let skipped = 0;
  for (const r of source.all(table)) {
    const id = num(r, "Id");
    const mediaId = media.mediaIdOf(r);
    if (id == null || !mediaId) continue;
    const derivedId = `imp_h${idPrefix}${id}`;
    const exists = await target.select().from(schema.historyEntry).where(eq(schema.historyEntry.id, derivedId)).limit(1);
    if (exists[0]) { skipped++; continue; }
    const action = mapHistoryAction(num(r, "EventType"));
    if (action === "unknown") continue;
    const date = num(r, "Date") ?? num(r, "DateUtc") ?? Date.now();
    await target.insert(schema.historyEntry).values({
      id: derivedId, mediaType: media.mediaType, mediaId, action,
      data: {
        releaseTitle: str(r, "SourceTitle") ?? str(r, "Title") ?? "",
        indexerId: str(r, "IndexerId") ?? undefined,
        quality: jsonc(r, "Quality", {}),
      },
      createdAt: new Date(date).toISOString(),
    }).onConflictDoNothing();
    count++;
  }
  return { count, skipped };
}

export { and, eq };
