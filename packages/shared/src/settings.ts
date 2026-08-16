// SPDX-License-Identifier: MIT
import { z } from "zod";

/** Runtime (admin-editable) settings stored in the `setting` table as namespaced keys. */
export const settingValueSchema = z.unknown();

export const webhookNotificationSchema = z.object({
  url: z.string().url(),
  secret: z.string().optional(),
  eventTypes: z.array(z.string()).default(["requests.request.approved", "requests.request.fulfilled", "requests.request.created", "requests.request.declined", "acquisition.import.completed", "acquisition.release.grabbed"]),
});
export type WebhookNotificationConfig = z.infer<typeof webhookNotificationSchema>;

export const discordNotificationSchema = z.object({
  webhookUrl: z.string().url(),
  eventTypes: z.array(z.string()).default([]),
});
export type DiscordNotificationConfig = z.infer<typeof discordNotificationSchema>;

export const telegramNotificationSchema = z.object({
  botToken: z.string().min(1),
  chatId: z.string().min(1),
  /** test/dev override — defaults to https://api.telegram.org */
  baseUrl: z.string().optional(),
  eventTypes: z.array(z.string()).default([]),
});
export type TelegramNotificationConfig = z.infer<typeof telegramNotificationSchema>;

export const emailNotificationSchema = z.object({
  from: z.string().email(),
  to: z.array(z.string().email()).min(1),
  transport: z.object({
    host: z.string().min(1),
    port: z.number().int().default(587),
    secure: z.boolean().default(false),
    auth: z.object({ user: z.string(), pass: z.string() }).optional(),
  }),
  subject: z.string().default("MediaNexus notification"),
  eventTypes: z.array(z.string()).default([]),
});
export type EmailNotificationConfig = z.infer<typeof emailNotificationSchema>;

export const mediaServerConfigSchema = z.object({
  name: z.string().min(1),
  implementation: z.enum(["jellyfin", "plex"]).default("jellyfin"),
  enabled: z.boolean().default(true),
  settings: z.record(z.string(), z.unknown()).default({}),
});
export type MediaServerConfig = z.infer<typeof mediaServerConfigSchema>;

export const namingSchema = z.object({
  movies: z.string().min(1).default("{Movie Title} ({Release Year})"),
  episodes: z.string().min(1).default("{Series Title} - S{season:00}E{episode:00} - {Episode Title}"),
});

export const runtimeSettingsSchema = z.object({
  "paths.downloads": z.string().default(""),
  "media.naming": namingSchema.default({
    movies: "{Movie Title} ({Release Year})",
    episodes: "{Series Title} - S{season:00}E{episode:00} - {Episode Title}",
  }),
  "media.preferredProtocol": z.enum(["usenet", "torrent", "any"]).default("any"),
  "media.downloadStallMinutes": z.number().int().positive().default(60),
  // Safety margin required to remain on the target root folder's filesystem after a
  // release downloads (roadmap P1, gap report B8) — matches Sonarr/Radarr's "Minimum Free
  // Space When Importing" default. Root folders themselves are a real entity now (the
  // `root_folder` table), not a setting — see RootFoldersService.
  "media.minimumFreeSpaceMb": z.number().int().nonnegative().default(100),
  // Recycle bin for superseded/deleted media files (roadmap P1, gap report B7). Empty path
  // means disabled — files are deleted outright, matching pre-B7 behavior. Retention is
  // enforced by the media.recycleBinTrim job (packages/database/src/seed.ts).
  "media.recycleBinPath": z.string().default(""),
  "media.recycleBinRetentionDays": z.number().int().nonnegative().default(7),
  "discovery.flareSolverrBaseUrl": z.string().default(""),
  // Per-indexer rate limiting (roadmap P1, gap report B10). A sliding window over
  // `indexers.rateLimitWindowSeconds`; a provider that exceeds the cap is skipped by
  // ProviderStatusService.beforeCall() until the window rolls over. Generous defaults so
  // normal operations (search fans out over N indexers; RSS polls a few times/hour) are
  // unaffected — this guards against a runaway or hostile indexer, not routine use.
  "indexers.rateLimitWindowSeconds": z.number().int().positive().default(60),
  "indexers.maxQueriesPerWindow": z.number().int().positive().default(20),
  "indexers.maxGrabsPerWindow": z.number().int().positive().default(5),
  "metadata.tmdbApiKey": z.string().default(""),
  "metadata.tmdbBaseUrl": z.string().default(""),
  // TheTVDB numbering backfill (roadmap P2, gap D8). Empty baseUrl -> the shared Cloudflare
  // proxy default (DEFAULT_TVDB_WORKER_URL) is used; an empty apiKey means shared-proxy mode,
  // a non-empty one means BYO-key mode against the real TVDB API. The apiKey is a J9 secret.
  "metadata.tvdbBaseUrl": z.string().default(""),
  "metadata.tvdbApiKey": z.string().default(""),
  "ui.theme": z.enum(["dark", "light"]).default("dark"),
  // Housekeeping retention windows (roadmap P1, gap report B9). Orphan rows (no matching
  // movie/series) are always swept regardless of age; these only bound the unconditional
  // growth of terminal/completed rows. history_entry is deliberately not age-trimmed — it's
  // the user-facing "what happened" record.
  "system.housekeeping.jobRunRetentionDays": z.number().int().nonnegative().default(30),
  "system.housekeeping.auditLogRetentionDays": z.number().int().nonnegative().default(90),
  "system.housekeeping.queueRetentionDays": z.number().int().nonnegative().default(14),
  // Gap report B6's own forward-reference: blocklist entries expire via housekeeping (B9).
  "system.housekeeping.blocklistRetentionDays": z.number().int().nonnegative().default(30),
  // Backup (roadmap P1, gap report B9). Empty path means disabled — the job no-ops rather
  // than falling back to a path inside the app's own working directory.
  "system.backupPath": z.string().default(""),
  "system.backupRetentionCount": z.number().int().nonnegative().default(7),
});

export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;

export const DEFAULT_SETTINGS: RuntimeSettings = runtimeSettingsSchema.parse({});

/** The set of allowed setting keys (for PUT config validation). */
export const settingKeys = Object.keys(runtimeSettingsSchema.shape) as (keyof RuntimeSettings)[];
