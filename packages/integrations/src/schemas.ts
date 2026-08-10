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
});
export type QbittorrentSettings = z.infer<typeof qbittorrentSettingsSchema>;

export const notificationWebhookSchema = z.object({
  url: z.string().url(),
  method: z.enum(["POST", "PUT"]).default("POST"),
  secret: z.string().optional(),
});
export type NotificationWebhookSettings = z.infer<typeof notificationWebhookSchema>;
