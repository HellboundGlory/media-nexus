// SPDX-License-Identifier: MIT
/**
 * MediaNexus unified storage schema (Drizzle, SQLite dialect).
 * Derives from docs/architecture/domain-model.md — that document is the source of truth.
 *
 * NOTE: SQLite is the fully-wired default. PostgreSQL is a targeted follow-up: Drizzle's
 * pg-core port of this schema is a contained, mechanical change (see roadmap M1.1).
 */
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql, type SQL } from "drizzle-orm";

// ---------- helpers ----------
const iso = (name: string) => text(name).notNull();
const nullableIso = (name: string) => text(name);
const bool = (name: string, def: boolean) =>
  integer(name, { mode: "boolean" }).notNull().default(def);
const json = <T,>(name: string, def: SQL = sql`'[]'`) =>
  text(name, { mode: "json" }).$type<T>().notNull().default(def);

// ---------- 1. Identity & access ----------
export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  username: text("username").notNull(),
  email: text("email"),
  passwordHash: text("password_hash"), // bcrypt
  isAdmin: bool("is_admin", false),
  roles: json<string[]>("roles", sql`'[]'`),
  plexToken: text("plex_token"),
  jellyfinToken: text("jellyfin_token"),
  createdAt: iso("created_at"),
  updatedAt: iso("updated_at"),
}, (t) => [uniqueIndex("user_username_idx").on(t.username)]);

export const apiKey = sqliteTable("api_key", {
  id: text("id").primaryKey(),
  userId: text("user_id"), // null = system/global key (arr-style)
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull(), // sha256 of the raw key — never stored plain
  scopes: json<string[]>("scopes", sql`'[]'`),
  lastUsedAt: nullableIso("last_used_at"),
  expiresAt: nullableIso("expires_at"),
  createdAt: iso("created_at"),
}, (t) => [uniqueIndex("api_key_hash_idx").on(t.keyHash), index("api_key_user_idx").on(t.userId)]);

// ---------- 2. Configuration ----------
export const setting = sqliteTable("setting", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).$type<unknown>().notNull(),
  updatedAt: iso("updated_at"),
});

// Shared quality profiles (movies + series)
export const qualityProfile = sqliteTable("quality_profile", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  allowed: text("allowed", { mode: "json" }).$type<{ source: string; resolution: string }[]>().notNull(),
  cutoff: text("cutoff", { mode: "json" }).$type<{ source: string; resolution: string }>().notNull(),
  upgradeAllowed: bool("upgrade_allowed", true),
  language: text("language").notNull().default("en"),
  isDefault: bool("is_default", false),
  createdAt: iso("created_at"),
  updatedAt: iso("updated_at"),
});

// ---------- 3. Media ----------
export const movie = sqliteTable("movie", {
  id: text("id").primaryKey(),
  tmdbId: integer("tmdb_id"),
  imdbId: text("imdb_id"),
  title: text("title").notNull(),
  originalTitle: text("original_title"),
  overview: text("overview").notNull().default(""),
  status: text("status").notNull().default("unknown"),
  releaseDate: text("release_date"),
  monitored: bool("monitored", true),
  qualityProfileId: text("quality_profile_id"),
  rootFolderPath: text("root_folder_path").notNull().default(""),
  minimumAvailability: text("minimum_availability").notNull().default("announced"),
  genres: json<string[]>("genres"),
  images: json<Record<string, string>[]>("images"),
  tags: json<string[]>("tags"),
  hasFile: bool("has_file", false),
  addedAt: iso("added_at"),
  updatedAt: iso("updated_at"),
}, (t) => [uniqueIndex("movie_tmdb_idx").on(t.tmdbId)]);

export const series = sqliteTable("series", {
  id: text("id").primaryKey(),
  tvdbId: integer("tvdb_id"),
  imdbId: text("imdb_id"),
  title: text("title").notNull(),
  overview: text("overview").notNull().default(""),
  status: text("status").notNull().default("unknown"),
  seriesType: text("series_type").notNull().default("standard"),
  network: text("network"),
  firstAirYear: integer("first_air_year"),
  monitored: bool("monitored", true),
  qualityProfileId: text("quality_profile_id"),
  rootFolderPath: text("root_folder_path").notNull().default(""),
  genres: json<string[]>("genres"),
  images: json<Record<string, string>[]>("images"),
  tags: json<string[]>("tags"),
  addedAt: iso("added_at"),
  updatedAt: iso("updated_at"),
}, (t) => [uniqueIndex("series_tvdb_idx").on(t.tvdbId)]);

export const season = sqliteTable("season", {
  id: text("id").primaryKey(),
  seriesId: text("series_id").notNull(),
  seasonNumber: integer("season_number").notNull(),
  monitored: bool("monitored", true),
  qualityProfileId: text("quality_profile_id"),
}, (t) => [
  uniqueIndex("season_series_num_idx").on(t.seriesId, t.seasonNumber),
  index("season_series_idx").on(t.seriesId),
]);

export const episode = sqliteTable("episode", {
  id: text("id").primaryKey(),
  seriesId: text("series_id").notNull(),
  seasonId: text("season_id").notNull(),
  episodeNumber: integer("episode_number").notNull(),
  absoluteNumber: integer("absolute_number"),
  title: text("title").notNull().default(""),
  overview: text("overview").notNull().default(""),
  airDateUtc: text("air_date_utc"),
  monitored: bool("monitored", true),
  hasFile: bool("has_file", false),
  sceneSeasonNumber: integer("scene_season_number"),
  sceneEpisodeNumber: integer("scene_episode_number"),
}, (t) => [
  index("episode_series_idx").on(t.seriesId),
  index("episode_season_idx").on(t.seasonId),
]);

export const mediaFile = sqliteTable("media_file", {
  id: text("id").primaryKey(),
  mediaType: text("media_type").notNull(), // movie | series
  mediaId: text("media_id").notNull(), // movie.id | series.id
  episodeIds: json<string[]>("episode_ids"), // episode ids for episode files
  relativePath: text("relative_path").notNull(),
  size: integer("size").notNull().default(0),
  quality: json<{ source: string; resolution: string; edition: string }>("quality"),
  mediaInfo: json<Record<string, unknown>>("media_info"),
  languages: json<string[]>("languages"),
  dateAdded: iso("date_added"),
}, (t) => [index("media_file_media_idx").on(t.mediaType, t.mediaId)]);

// ---------- 4. Discovery (indexers) ----------
export const indexerDefinition = sqliteTable("indexer_definition", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  protocol: text("protocol").notNull(), // usenet | torrent
  implementation: text("implementation").notNull(),
  builtIn: bool("built_in", true),
  capabilities: json<Record<string, unknown>>("capabilities"),
  categoryIds: json<number[]>("category_ids"),
  cardigannYml: text("cardigann_yml"),
  createdAt: iso("created_at"),
});

export const indexer = sqliteTable("indexer", {
  id: text("id").primaryKey(),
  definitionKey: text("definition_key").notNull(),
  name: text("name").notNull(),
  protocol: text("protocol").notNull(),
  enabled: bool("enabled", true),
  implementation: text("implementation").notNull(),
  settings: text("settings", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  proxy: text("proxy", { mode: "json" }).$type<Record<string, unknown> | null>(),
  priority: integer("priority").notNull().default(25),
  status: text("status").notNull().default("disabled"), // ok | error | disabled
  lastError: text("last_error"),
  lastSyncAt: text("last_sync_at"),
  tags: json<string[]>("tags"),
  createdAt: iso("created_at"),
  updatedAt: iso("updated_at"),
});

export const downloadClient = sqliteTable("download_client", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  implementation: text("implementation").notNull(),
  kind: text("kind").notNull(), // usenet | torrent
  enabled: bool("enabled", true),
  priority: integer("priority").notNull().default(1),
  settings: text("settings", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  tags: json<string[]>("tags"),
  createdAt: iso("created_at"),
  updatedAt: iso("updated_at"),
});

// ---------- 5. Acquisition ----------
export const downloadQueueEntry = sqliteTable("download_queue_entry", {
  id: text("id").primaryKey(),
  mediaType: text("media_type").notNull(),
  mediaId: text("media_id").notNull(),
  downloadClientId: text("download_client_id"),
  downloadId: text("download_id"), // client-side id
  title: text("title").notNull(),
  status: text("status").notNull().default("queued"),
  progress: integer("progress").notNull().default(0),
  size: integer("size").notNull().default(0),
  remainingTime: integer("remaining_time"),
  errorMessage: text("error_message"),
  addedAt: iso("added_at"),
  updatedAt: iso("updated_at"),
}, (t) => [index("queue_media_idx").on(t.mediaType, t.mediaId)]);

export const historyEntry = sqliteTable("history_entry", {
  id: text("id").primaryKey(),
  mediaType: text("media_type").notNull(),
  mediaId: text("media_id").notNull(),
  action: text("action").notNull(),
  data: text("data", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  createdAt: iso("created_at"),
}, (t) => [index("history_media_idx").on(t.mediaType, t.mediaId), index("history_created_idx").on(t.createdAt)]);

export const blocklistEntry = sqliteTable("blocklist_entry", {
  id: text("id").primaryKey(),
  mediaType: text("media_type").notNull(),
  mediaId: text("media_id").notNull(),
  indexerId: text("indexer_id"),
  title: text("title").notNull(),
  torrentInfohash: text("torrent_infohash"),
  reason: text("reason"),
  createdAt: iso("created_at"),
});

// ---------- 6. Requests ----------
export const mediaAvailability = sqliteTable("media_availability", {
  id: text("id").primaryKey(),
  mediaType: text("media_type").notNull(),
  mediaId: text("media_id").notNull(),
  status: text("status").notNull().default("unknown"),
  plexId: text("plex_id"),
  jellyfinId: text("jellyfin_id"),
  tmdbRating: integer("tmdb_rating"),
  tmdbVoteCount: integer("tmdb_vote_count"),
  lastAvailabilitySyncAt: text("last_availability_sync_at"),
}, (t) => [uniqueIndex("availability_media_idx").on(t.mediaType, t.mediaId)]);

export const request = sqliteTable("request", {
  id: text("id").primaryKey(),
  userRequestorId: text("user_requestor_id"),
  mediaType: text("media_type").notNull(),
  mediaId: text("media_id").notNull(),
  status: text("status").notNull().default("pending"),
  isAutoApproval: bool("is_auto_approval", false),
  adminNote: text("admin_note"),
  requestedAt: iso("requested_at"),
  updatedAt: iso("updated_at"),
}, (t) => [index("request_media_idx").on(t.mediaType, t.mediaId), index("request_user_idx").on(t.userRequestorId)]);

// ---------- 7. Jobs ----------
export const jobDefinition = sqliteTable("job_definition", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  schedule: text("schedule").notNull(), // cron expression
  enabled: bool("enabled", true),
  timeoutMs: integer("timeout_ms").notNull().default(60_000),
  maxRetries: integer("max_retries").notNull().default(2),
  retryBackoffMs: integer("retry_backoff_ms").notNull().default(5_000),
  priority: integer("priority").notNull().default(100),
  concurrencyLimit: integer("concurrency_limit").notNull().default(1),
  createdAt: iso("created_at"),
  updatedAt: iso("updated_at"),
});

export const jobRun = sqliteTable("job_run", {
  id: text("id").primaryKey(),
  jobKey: text("job_key").notNull(),
  status: text("status").notNull().default("queued"),
  trigger: text("trigger").notNull().default("scheduled"), // scheduled | manual | event
  attempt: integer("attempt").notNull().default(1),
  progress: integer("progress").notNull().default(0),
  message: text("message"),
  error: text("error"),
  payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
  result: text("result", { mode: "json" }).$type<Record<string, unknown> | null>(),
  correlationId: text("correlation_id"),
  dueAt: text("due_at"),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
  createdAt: iso("created_at"),
}, (t) => [index("jobrun_key_idx").on(t.jobKey), index("jobrun_status_idx").on(t.status), index("jobrun_created_idx").on(t.createdAt)]);

// ---------- 8. Observability ----------
export const auditLog = sqliteTable("audit_log", {
  id: text("id").primaryKey(),
  correlationId: text("correlation_id"),
  actor: text("actor").notNull().default("system"),
  action: text("action").notNull(),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  details: text("details", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
  ip: text("ip"),
  createdAt: iso("created_at"),
}, (t) => [index("audit_created_idx").on(t.createdAt), index("audit_entity_idx").on(t.entityType, t.entityId)]);

// ---------- exported schema ----------
export const schema = {
  user,
  apiKey,
  setting,
  qualityProfile,
  movie,
  series,
  season,
  episode,
  mediaFile,
  indexerDefinition,
  indexer,
  downloadClient,
  downloadQueueEntry,
  historyEntry,
  blocklistEntry,
  mediaAvailability,
  request,
  jobDefinition,
  jobRun,
  auditLog,
};

export type Schema = typeof schema;
