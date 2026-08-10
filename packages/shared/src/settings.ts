// SPDX-License-Identifier: MIT
import { z } from "zod";

/** Runtime (admin-editable) settings stored in the `setting` table as namespaced keys. */
export const settingValueSchema = z.unknown();

export const rootFolderSchema = z.object({
  path: z.string(),
  name: z.string().optional(),
});

export const namingSchema = z.object({
  movies: z.string().default("{Movie Title} ({Release Year})"),
  episodes: z.string().default("{Series Title} - S{season:00}E{episode:00} - {Episode Title}"),
});

export const runtimeSettingsSchema = z.object({
  "paths.rootFolders": z.array(rootFolderSchema).default([]),
  "paths.downloads": z.string().default(""),
  "media.naming": namingSchema.default({
    movies: "{Movie Title} ({Release Year})",
    episodes: "{Series Title} - S{season:00}E{episode:00} - {Episode Title}",
  }),
  "media.preferredProtocol": z.enum(["usenet", "torrent", "any"]).default("any"),
  "system.timezone": z.string().default("UTC"),
  "ui.theme": z.enum(["dark", "light"]).default("dark"),
});

export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;

export const DEFAULT_SETTINGS: RuntimeSettings = runtimeSettingsSchema.parse({});

/** The set of allowed setting keys (for PUT config validation). */
export const settingKeys = Object.keys(runtimeSettingsSchema.shape) as (keyof RuntimeSettings)[];
