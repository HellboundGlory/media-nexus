// SPDX-License-Identifier: MIT
import { eq } from "drizzle-orm";
import type { Db } from "./connection";
import { schema } from "./schema";

/** Idempotent static seed: shared quality profiles, canonical indexer definitions,
 *  and the default job definitions. Bootstrap admin + API key are created by the API
 *  on first boot (they require hashing + secret handling) — see apps/api/src/bootstrap. */
export async function seedStatic(db: Db): Promise<void> {
  // --- Quality profiles (shared across movies & series) ---
  const profiles = [
    { name: "Any", allowed: [{ source: "sd", resolution: "480p" }, { source: "sd", resolution: "576p" }, { source: "hdtv", resolution: "720p" }, { source: "web", resolution: "720p" }, { source: "web", resolution: "1080p" }, { source: "bluray", resolution: "1080p" }, { source: "bluray", resolution: "2160p" }], cutoff: { source: "web", resolution: "1080p" }, upgradeAllowed: true },
    { name: "HD-1080p", allowed: [{ source: "hdtv", resolution: "720p" }, { source: "web", resolution: "720p" }, { source: "web", resolution: "1080p" }, { source: "bluray", resolution: "1080p" }], cutoff: { source: "web", resolution: "1080p" }, upgradeAllowed: true },
    { name: "UHD-2160p", allowed: [{ source: "web", resolution: "2160p" }, { source: "bluray", resolution: "2160p" }], cutoff: { source: "bluray", resolution: "2160p" }, upgradeAllowed: true },
  ];
  for (const [i, p] of profiles.entries()) {
    const existing = await db.select().from(schema.qualityProfile).where(eq(schema.qualityProfile.name, p.name)).limit(1);
    if (existing.length) continue;
    await db.insert(schema.qualityProfile).values({
      id: `qp_${p.name.toLowerCase().replace(/[^a-z0-9]+/g, "")}`,
      name: p.name,
      allowed: p.allowed,
      cutoff: p.cutoff,
      upgradeAllowed: p.upgradeAllowed,
      isDefault: i === 0,
      language: "en",
      createdAt: new Date().toISOString(),
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
    { key: "media.rssSync", name: "RSS sync", description: "Auto-search and grab missing monitored episodes", schedule: "*/10 * * * *", timeoutMs: 180_000, maxRetries: 2, priority: 60 },
    { key: "media.availabilityRefresh", name: "Availability refresh", description: "Sync availability from configured media servers", schedule: "0 */4 * * *", timeoutMs: 120_000, maxRetries: 2, priority: 100 },
    { key: "media.metadataRefresh", name: "Metadata refresh", description: "Populate series seasons/episodes from TMDB for items missing them (metadata import)", schedule: "0 3 * * *", timeoutMs: 300_000, maxRetries: 2, priority: 150 },
  ];
  for (const j of jobs) {
    const existing = await db.select().from(schema.jobDefinition).where(eq(schema.jobDefinition.key, j.key)).limit(1);
    if (existing.length) continue;
    const now = new Date().toISOString();
    await db.insert(schema.jobDefinition).values({ id: `jobdef_${j.key.replace(/\./g, "_")}`, key: j.key, name: j.name, description: j.description, schedule: j.schedule, enabled: true, timeoutMs: j.timeoutMs, maxRetries: j.maxRetries, retryBackoffMs: 5000, priority: j.priority, concurrencyLimit: 1, createdAt: now, updatedAt: now });
  }
}
