// SPDX-License-Identifier: MIT
import { z } from "zod";

/** zod config schemas for the first-wave providers.
 *  Stored `settings` JSON is validated against these before persisting. */

// --- Indexers ---
export const newznabSettingsSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  categories: z.array(z.number()).default([5000, 5010, 5020, 5030, 5040]),
  username: z.string().optional(),
  password: z.string().optional(),
  sort: z.enum(["date", "size", "seeders"]).default("date"),
});
export type NewznabSettings = z.infer<typeof newznabSettingsSchema>;

export const torznabSettingsSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
  categories: z.array(z.number()).default([2000, 5000, 5010, 5020, 5030, 5040]),
  username: z.string().optional(),
  password: z.string().optional(),
  limit: z.number().int().positive().default(100),
});
export type TorznabSettings = z.infer<typeof torznabSettingsSchema>;

export const indexerProxySchema = z.object({
  enabled: z.boolean().default(false),
  type: z.enum(["http", "socks4", "socks5"]).default("http"),
  host: z.string(),
  port: z.number().int().positive(),
  username: z.string().optional(),
  password: z.string().optional(),
  flareSolverr: z.boolean().default(false),
});
export type IndexerProxy = z.infer<typeof indexerProxySchema>;

// --- Download clients ---
/** Seed-goal / removal policy persisted in a torrent client's `settings` JSON (roadmap P2,
 *  gap report D3). `seedRatioGoal` and `seedTimeMinutes` are the minimum ratio and seed time
 *  a completed torrent must reach before the app reaps it from the client; `removeOnImport`
 *  removes a download from the client immediately once it is imported. An unset goal is
 *  treated as already satisfied, so setting only one still works. */
export const seedGoalFields = z.object({
  seedRatioGoal: z.number().min(0).optional(),
  seedTimeMinutes: z.number().int().min(0).optional(),
  removeOnImport: z.boolean().optional(),
});
export type SeedGoalFields = z.infer<typeof seedGoalFields>;

/** Per-client category-to-root-folder routing (gap report D3; distinct from C6's tag-based
 *  media→client routing). Maps a category label (e.g. `movie`, `series`) to a destination
 *  directory on the *client* (a save path / download-dir), applied at addRelease time. For
 *  torrent clients this overrides the generic `savePath`/`downloadDir`. Usenet clients route
 *  categories to folders server-side, so this is a torrent concern only. */
export const categoryRoutesSchema = z.record(z.string(), z.string());

export const sabnzbdSettingsSchema = z.object({
  host: z.string().url(),
  apiKey: z.string().min(1),
  category: z.string().default("movies"),
  priority: z.number().int().default(0),
});
export type SabnzbdSettings = z.infer<typeof sabnzbdSettingsSchema>;

export const qbittorrentSettingsSchema = z.object({
  host: z.string().url(),
  username: z.string().optional(),
  password: z.string().optional(),
  category: z.string().default("movies"),
  savePath: z.string().optional(),
  tag: z.string().default("media-nexus"),
  ...seedGoalFields.shape,
  categoryRoutes: categoryRoutesSchema.optional(),
});
export type QbittorrentSettings = z.infer<typeof qbittorrentSettingsSchema>;

/** Transmission (RPC v2) — JSON-RPC over `/transmission/rpc` with a lazy session-id
 *  challenge (409) as auth. `downloadDir` is the destination directory on the client. */
export const transmissionSettingsSchema = z.object({
  host: z.string().url(),
  username: z.string().optional(),
  password: z.string().optional(),
  category: z.string().default("movies"),
  downloadDir: z.string().optional(),
  ...seedGoalFields.shape,
  categoryRoutes: categoryRoutesSchema.optional(),
});
export type TransmissionSettings = z.infer<typeof transmissionSettingsSchema>;

/** NZBGet — JSON-RPC 2.0 over `/jsonrpc`. `category` and `priority` map onto the NZBGet
 *  append call; per-category folders are configured on the NZBGet side, so the app only
 *  passes the category label (no category-to-root routing — see categoryRoutesSchema). */
export const nzbgetSettingsSchema = z.object({
  host: z.string().url(),
  username: z.string().optional(),
  password: z.string().optional(),
  category: z.string().default("movies"),
  // Coerce: the Clients UI sends settings through a string-valued pipeline, and this is NZBGet's
  // per-job int priority (distinct from the app's client-selection priority).
  priority: z.coerce.number().int().default(0),
});
export type NzbgetSettings = z.infer<typeof nzbgetSettingsSchema>;

export const notificationWebhookSchema = z.object({
  url: z.string().url(),
  method: z.enum(["POST", "PUT"]).default("POST"),
  secret: z.string().optional(),
});
export type NotificationWebhookSettings = z.infer<typeof notificationWebhookSchema>;
