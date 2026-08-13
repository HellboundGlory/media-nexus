// SPDX-License-Identifier: MIT
import { eq } from "drizzle-orm";
import { QUALITY_REGISTRY, qualityId } from "@medianexus/domain";
import type { Db } from "./connection";
import { schema } from "./schema";

const q = (source: string, resolution: string) => qualityId({ source, resolution, edition: "" } as never);

/** Idempotent static seed: shared quality profiles, quality size definitions,
 *  canonical indexer definitions, and the default job definitions. Bootstrap
 *  admin + API key are created by the API on first boot (they require hashing +
 *  secret handling) — see apps/api/src/bootstrap. */
export async function seedStatic(db: Db): Promise<void> {
  // --- Quality profiles (shared across movies & series) ---
  // `items` is ordered worst -> best (upstream convention); see packages/domain/src/quality.ts.
  const profiles = [
    {
      name: "Any",
      items: [q("sd", "480p"), q("sd", "576p"), q("hdtv", "720p"), q("web", "720p"), q("web", "1080p"), q("bluray", "1080p"), q("bluray", "2160p")],
      cutoffQualityId: q("web", "1080p"),
    },
    {
      name: "HD-1080p",
      items: [q("hdtv", "720p"), q("web", "720p"), q("web", "1080p"), q("bluray", "1080p")],
      cutoffQualityId: q("web", "1080p"),
    },
    {
      name: "UHD-2160p",
      items: [q("web", "2160p"), q("bluray", "2160p")],
      cutoffQualityId: q("bluray", "2160p"),
    },
  ];
  for (const [i, p] of profiles.entries()) {
    const existing = await db.select().from(schema.qualityProfile).where(eq(schema.qualityProfile.name, p.name)).limit(1);
    if (existing.length) continue;
    await db.insert(schema.qualityProfile).values({
      id: `qp_${p.name.toLowerCase().replace(/[^a-z0-9]+/g, "")}`,
      name: p.name,
      items: p.items,
      cutoffQualityId: p.cutoffQualityId,
      upgradeAllowed: true,
      isDefault: i === 0,
      language: "en",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  // --- Quality size definitions (min/max/preferred MB per runtime-minute) ---
  // Seeded by resolution tier; source doesn't change the expected bitrate envelope.
  // Not consumed by anything yet — the decision engine's size specification
  // (roadmap P0.3) is the intended reader.
  const sizeByResolution: Record<string, { minSize: number | null; maxSize: number | null; preferredSize: number | null }> = {
    unknown: { minSize: null, maxSize: null, preferredSize: null },
    "480p": { minSize: 2, maxSize: 100, preferredSize: 35 },
    "576p": { minSize: 2, maxSize: 110, preferredSize: 40 },
    "720p": { minSize: 4, maxSize: 200, preferredSize: 65 },
    "1080p": { minSize: 8, maxSize: 320, preferredSize: 110 },
    "2160p": { minSize: 20, maxSize: 900, preferredSize: 300 },
  };
  for (const def of QUALITY_REGISTRY) {
    const existing = await db.select().from(schema.qualityDefinition).where(eq(schema.qualityDefinition.id, def.id)).limit(1);
    if (existing.length) continue;
    const size = sizeByResolution[def.resolution];
    await db.insert(schema.qualityDefinition).values({
      id: def.id,
      title: def.title,
      minSize: size.minSize,
      maxSize: size.maxSize,
      preferredSize: size.preferredSize,
      updatedAt: new Date().toISOString(),
    });
  }

  // --- Canonical indexer definitions (Newznab/Torznab; curated catalog) ---
  const defs = [
    { key: "generic-newznab", name: "Generic Newznab", protocol: "usenet", implementation: "newznab", categoryIds: [5000, 5010, 5020, 5030, 5040] },
    { key: "generic-torznab", name: "Generic Torznab", protocol: "torrent", implementation: "torznab", categoryIds: [2000, 5000, 5010, 5020, 5030, 5040] },
    { key: "nzbgeek", name: "NZBgeek", protocol: "usenet", implementation: "newznab", categoryIds: [5000, 5010, 5020, 5030, 5040] },
    { key: "nzb.su", name: "NZB.su", protocol: "usenet", implementation: "newznab", categoryIds: [5000, 5010, 5020, 5030, 5040] },
    { key: "tvtorrents", name: "TVTorrents", protocol: "torrent", implementation: "torznab", categoryIds: [5000, 5010, 5020, 5030] },
    { key: "memory", name: "Demo (in-memory)", protocol: "torrent", implementation: "memory", categoryIds: [2000] },
  ];
  for (const d of defs) {
    const existing = await db.select().from(schema.indexerDefinition).where(eq(schema.indexerDefinition.key, d.key)).limit(1);
    if (existing.length) continue;
    const now = new Date().toISOString();
    await db.insert(schema.indexerDefinition).values({
      id: `idef_${d.key}`,
      key: d.key,
      name: d.name,
      protocol: d.protocol,
      implementation: d.implementation,
      builtIn: true,
      capabilities: { search: true, categories: true },
      categoryIds: d.categoryIds,
      createdAt: now,
    });
  }

  // --- Default job definitions ---
  const jobs = [
    { key: "system.healthCheck", name: "System health check", description: "Heartbeat + system status refresh", schedule: "*/5 * * * *", timeoutMs: 20_000, maxRetries: 3, priority: 50 },
    { key: "discovery.indexerRefresh", name: "Indexer health refresh", description: "Re-check configured indexers", schedule: "0 */6 * * *", timeoutMs: 120_000, maxRetries: 2, priority: 100 },
    { key: "system.metadataCleanup", name: "Metadata cleanup", description: "Prune stale availability/history", schedule: "0 4 * * *", timeoutMs: 60_000, maxRetries: 1, priority: 200 },
    { key: "acquisition.downloadMonitor", name: "Download monitor", description: "Poll download clients and import completed downloads", schedule: "*/1 * * * *", timeoutMs: 60_000, maxRetries: 2, priority: 80 },
    { key: "media.rssSync", name: "RSS sync", description: "Poll configured indexers' recent-releases feeds and auto-grab matches for monitored missing movies/episodes", schedule: "*/10 * * * *", timeoutMs: 180_000, maxRetries: 2, priority: 60 },
    { key: "media.missingSearch", name: "Missing search", description: "Actively search indexers for monitored missing movies/episodes the passive RSS poll hasn't caught (safety net)", schedule: "0 5 * * *", timeoutMs: 180_000, maxRetries: 2, priority: 60 },
    { key: "media.availabilityRefresh", name: "Availability refresh", description: "Sync availability from configured media servers", schedule: "0 */4 * * *", timeoutMs: 120_000, maxRetries: 2, priority: 100 },
    { key: "media.metadataRefresh", name: "Metadata refresh", description: "Populate series seasons/episodes from TMDB for items missing them (metadata import)", schedule: "0 3 * * *", timeoutMs: 300_000, maxRetries: 2, priority: 150 },
    { key: "library.scan", name: "Library scan", description: "Reconcile files on disk against the library — picks up files added outside the app and clears ones that vanished", schedule: "0 */6 * * *", timeoutMs: 300_000, maxRetries: 1, priority: 180 },
  ];
  for (const j of jobs) {
    const existing = await db.select().from(schema.jobDefinition).where(eq(schema.jobDefinition.key, j.key)).limit(1);
    if (existing.length) continue;
    const now = new Date().toISOString();
    await db.insert(schema.jobDefinition).values({ id: `jobdef_${j.key.replace(/\./g, "_")}`, key: j.key, name: j.name, description: j.description, schedule: j.schedule, enabled: true, timeoutMs: j.timeoutMs, maxRetries: j.maxRetries, retryBackoffMs: 5000, priority: j.priority, concurrencyLimit: 1, createdAt: now, updatedAt: now });
  }
}
