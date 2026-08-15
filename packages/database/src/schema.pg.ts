// SPDX-License-Identifier: MIT
/**
 * MediaNexus storage schema — PostgreSQL dialect twin of `schema.ts`.
 *
 * This is the Postgres mirror of the SQLite schema (roadmap P2 item 12 / M1.1). Each table
 * is structurally identical to its SQLite counterpart (same table/column names, same
 * relations, same IDs) so the two dialects store interchangeable data. Type/column-helper
 * translation vs SQLite:
 *   - `bool`  -> native Postgres `boolean` column (no integer emulation).
 *   - `json`  -> native `jsonb` (deliberate choice over `json` for indexability/perf).
 *   - `iso`/`nullableIso` -> stay `text` columns storing ISO-8601 strings, NOT native
 *     `timestamp`. Documented tradeoff (see ADR-004 / the Stage 1 plan): the whole app
 *     reads these via `new Date(row.field).getTime()` throughout, and switching to native
 *     timestamps would ripple a serialization-shape change through dozens of call sites
 *     well beyond Stage 1. Acceptable for now; revisit if native timestamp querying/
 *     indexing becomes a real limitation.
 *   - `integer`/`text`/`serial` -> native equivalents.
 *
 * The app layer (apps/api) is typed against the SQLite `schema`/`Db` and this file is
 * consumed only by the Postgres connection + migration path, where the pg database is
 * cast to the app's `Db` at the single `connection.ts` boundary (Option 1, approved).
 * See `connection.ts` for the cast rationale.
 */
import { pgTable, text, integer, boolean, jsonb, serial, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import type { CustomFormatSpec } from "@medianexus/domain";

// ---------- helpers ----------
const iso = (name: string) => text(name).notNull();
const nullableIso = (name: string) => text(name);
const bool = (name: string, def: boolean) => boolean(name).notNull().default(def);
const json = <T,>(name: string, def: SQL = sql`'[]'`) =>
  jsonb(name).$type<T>().notNull().default(def);
const nullableJson = <T,>(name: string) => jsonb(name).$type<T | null>();

// ---------- 1. Identity & access ----------
export const apiKey = pgTable("api_key", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull(),
  encryptedKey: text("encrypted_key"),
  scopes: json<string[]>("scopes", sql`'[]'`),
  lastUsedAt: nullableIso("last_used_at"),
  expiresAt: nullableIso("expires_at"),
  createdAt: iso("created_at"),
}, (t) => [uniqueIndex("api_key_hash_idx").on(t.keyHash)]);

export const adminCredential = pgTable("admin_credential", {
  id: text("id").primaryKey(),
  username: text("username").notNull(),
  passwordHash: text("password_hash").notNull(),
  passwordVersion: integer("password_version").notNull().default(1),
  createdAt: iso("created_at"),
  updatedAt: iso("updated_at"),
});

// ---------- 2. Configuration ----------
export const setting = pgTable("setting", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: iso("updated_at"),
});

export const qualityProfile = pgTable("quality_profile", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  items: json<number[]>("items"),
  cutoffQualityId: integer("cutoff_quality_id").notNull().default(0),
  upgradeAllowed: bool("upgrade_allowed", true),
  language: text("language").notNull().default("en"),
  isDefault: bool("is_default", false),
  formatScores: json<Record<string, number>>("format_scores", sql`'{}'`),
  minFormatScore: integer("min_format_score").notNull().default(0),
  cutoffFormatScore: integer("cutoff_format_score").notNull().default(0),
  createdAt: iso("created_at"),
  updatedAt: iso("updated_at"),
});

export const qualityDefinition = pgTable("quality_definition", {
  id: integer("id").primaryKey(),
  title: text("title").notNull(),
  minSize: integer("min_size"),
  maxSize: integer("max_size"),
  preferredSize: integer("preferred_size"),
  updatedAt: iso("updated_at"),
});

export const customFormat = pgTable("custom_format", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  specs: json<CustomFormatSpec[]>("specs").notNull(),
  createdAt: iso("created_at"),
  updatedAt: iso("updated_at"),
});

export const rootFolder = pgTable("root_folder", {
  id: text("id").primaryKey(),
  path: text("path").notNull(),
  name: text("name").notNull().default(""),
  isDefault: bool("is_default", false),
  createdAt: iso("created_at"),
}, (t) => [uniqueIndex("root_folder_path_idx").on(t.path)]);

// ---------- 3. Media ----------
export const movie = pgTable("movie", {
  id: text("id").primaryKey(),
  tmdbId: integer("tmdb_id"),
  imdbId: text("imdb_id"),
  title: text("title").notNull(),
  originalTitle: text("original_title"),
  overview: text("overview").notNull().default(""),
  status: text("status").notNull().default("unknown"),
  releaseDate: text("release_date"),
  monitored: bool("monitored", true),
  qualityProfileId: text("quality_profile_id").references(() => qualityProfile.id, { onDelete: "set null" }),
  rootFolderPath: text("root_folder_path").notNull().default(""),
  minimumAvailability: text("minimum_availability").notNull().default("announced"),
  genres: json<string[]>("genres"),
  images: json<Record<string, string>[]>("images"),
  tags: json<string[]>("tags"),
  hasFile: bool("has_file", false),
  addedAt: iso("added_at"),
  updatedAt: iso("updated_at"),
  lastRefreshedAt: nullableIso("last_refreshed_at"),
}, (t) => [uniqueIndex("movie_tmdb_idx").on(t.tmdbId)]);

export const series = pgTable("series", {
  id: text("id").primaryKey(),
  tvdbId: integer("tvdb_id"),
  tmdbId: integer("tmdb_id"),
  imdbId: text("imdb_id"),
  title: text("title").notNull(),
  overview: text("overview").notNull().default(""),
  status: text("status").notNull().default("unknown"),
  seriesType: text("series_type").notNull().default("standard"),
  network: text("network"),
  firstAirYear: integer("first_air_year"),
  monitored: bool("monitored", true),
  qualityProfileId: text("quality_profile_id").references(() => qualityProfile.id, { onDelete: "set null" }),
  rootFolderPath: text("root_folder_path").notNull().default(""),
  genres: json<string[]>("genres"),
  images: json<Record<string, string>[]>("images"),
  tags: json<string[]>("tags"),
  alternateTitles: json<string[]>("alternate_titles"),
  addedAt: iso("added_at"),
  updatedAt: iso("updated_at"),
  lastRefreshedAt: nullableIso("last_refreshed_at"),
}, (t) => [uniqueIndex("series_tvdb_idx").on(t.tvdbId), uniqueIndex("series_tmdb_idx").on(t.tmdbId)]);

export const season = pgTable("season", {
  id: text("id").primaryKey(),
  seriesId: text("series_id").notNull().references(() => series.id, { onDelete: "cascade" }),
  seasonNumber: integer("season_number").notNull(),
  monitored: bool("monitored", true),
}, (t) => [
  uniqueIndex("season_series_num_idx").on(t.seriesId, t.seasonNumber),
  index("season_series_idx").on(t.seriesId),
]);

export const episode = pgTable("episode", {
  id: text("id").primaryKey(),
  seriesId: text("series_id").notNull().references(() => series.id, { onDelete: "cascade" }),
  seasonId: text("season_id").notNull().references(() => season.id, { onDelete: "cascade" }),
  episodeNumber: integer("episode_number").notNull(),
  absoluteNumber: integer("absolute_number"),
  title: text("title").notNull().default(""),
  overview: text("overview").notNull().default(""),
  airDateUtc: text("air_date_utc"),
  monitored: bool("monitored", true),
  hasFile: bool("has_file", false),
  // Mirror of schema.ts: indexed back-reference to the covering media_file (gap report J3).
  mediaFileId: text("media_file_id").references(() => mediaFile.id, { onDelete: "set null" }),
  sceneSeasonNumber: integer("scene_season_number"),
  sceneEpisodeNumber: integer("scene_episode_number"),
}, (t) => [
  index("episode_series_idx").on(t.seriesId),
  index("episode_season_idx").on(t.seasonId),
  index("episode_media_file_idx").on(t.mediaFileId),
]);

export const mediaFile = pgTable("media_file", {
  id: text("id").primaryKey(),
  mediaType: text("media_type").notNull(),
  mediaId: text("media_id").notNull(),
  episodeIds: json<string[]>("episode_ids"),
  relativePath: text("relative_path").notNull(),
  size: integer("size").notNull().default(0),
  quality: json<{ source: string; resolution: string; edition: string }>("quality"),
  mediaInfo: json<Record<string, unknown>>("media_info"),
  languages: json<string[]>("languages"),
  dateAdded: iso("date_added"),
}, (t) => [index("media_file_media_idx").on(t.mediaType, t.mediaId)]);

// ---------- 4. Discovery (indexers) ----------
export const indexerDefinition = pgTable("indexer_definition", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  protocol: text("protocol").notNull(),
  implementation: text("implementation").notNull(),
  builtIn: bool("built_in", true),
  capabilities: json<Record<string, unknown>>("capabilities"),
  categoryIds: json<number[]>("category_ids"),
  cardigannYml: text("cardigann_yml"),
  createdAt: iso("created_at"),
});

export const indexer = pgTable("indexer", {
  id: text("id").primaryKey(),
  definitionKey: text("definition_key").notNull(),
  name: text("name").notNull(),
  protocol: text("protocol").notNull(),
  enabled: bool("enabled", true),
  implementation: text("implementation").notNull(),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull(),
  proxy: nullableJson<Record<string, unknown>>("proxy"),
  priority: integer("priority").notNull().default(25),
  status: text("status").notNull().default("disabled"),
  lastError: text("last_error"),
  lastSyncAt: text("last_sync_at"),
  capabilities: nullableJson<Record<string, unknown>>("capabilities"),
  sessionState: text("session_state"),
  tags: json<string[]>("tags"),
  createdAt: iso("created_at"),
  updatedAt: iso("updated_at"),
});

export const seenRelease = pgTable("seen_release", {
  id: text("id").primaryKey(),
  indexerId: text("indexer_id").notNull().references(() => indexer.id, { onDelete: "cascade" }),
  guid: text("guid").notNull(),
  firstSeenAt: iso("first_seen_at"),
}, (t) => [
  uniqueIndex("seen_release_indexer_guid_idx").on(t.indexerId, t.guid),
  index("seen_release_first_seen_idx").on(t.firstSeenAt),
]);

export const downloadClient = pgTable("download_client", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  implementation: text("implementation").notNull(),
  kind: text("kind").notNull(),
  enabled: bool("enabled", true),
  priority: integer("priority").notNull().default(1),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull(),
  tags: json<string[]>("tags"),
  createdAt: iso("created_at"),
  updatedAt: iso("updated_at"),
});

// ---------- Tag catalog ----------
export const tag = pgTable("tag", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  color: text("color"),
  createdAt: iso("created_at"),
  updatedAt: iso("updated_at"),
});

// ---------- Import lists ----------
export const importList = pgTable("import_list", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  name: text("name").notNull(),
  enabled: bool("enabled", true).notNull().default(true),
  config: jsonb("config").$type<Record<string, unknown>>().notNull(),
  lastSyncAt: text("last_synced_at"),
  lastError: text("last_error"),
  createdAt: iso("created_at"),
  updatedAt: iso("updated_at"),
});

export const importExclusion = pgTable("import_exclusion", {
  id: text("id").primaryKey(),
  mediaType: text("media_type").notNull(),
  externalId: text("external_id").notNull(),
  reason: text("reason"),
  createdAt: iso("created_at"),
}, (t) => [
  uniqueIndex("import_exclusion_media_ext_idx").on(t.mediaType, t.externalId),
]);

// ---------- 5. Acquisition ----------
export const remotePathMapping = pgTable("remote_path_mapping", {
  id: text("id").primaryKey(),
  downloadClientId: text("download_client_id").notNull().references(() => downloadClient.id, { onDelete: "cascade" }),
  remotePath: text("remote_path").notNull(),
  localPath: text("local_path").notNull(),
  createdAt: iso("created_at"),
}, (t) => [
  uniqueIndex("remote_path_mapping_client_remote_idx").on(t.downloadClientId, t.remotePath),
  index("remote_path_mapping_client_idx").on(t.downloadClientId),
]);

export const downloadQueueEntry = pgTable("download_queue_entry", {
  id: text("id").primaryKey(),
  mediaType: text("media_type").notNull(),
  mediaId: text("media_id").notNull(),
  downloadClientId: text("download_client_id").references(() => downloadClient.id, { onDelete: "set null" }),
  downloadId: text("download_id"),
  title: text("title").notNull(),
  status: text("status").notNull().default("queued"),
  progress: integer("progress").notNull().default(0),
  size: integer("size").notNull().default(0),
  remainingTime: integer("remaining_time"),
  errorMessage: text("error_message"),
  data: jsonb("data").$type<Record<string, unknown>>().notNull().default(sql`'{}'`),
  addedAt: iso("added_at"),
  updatedAt: iso("updated_at"),
}, (t) => [index("queue_media_idx").on(t.mediaType, t.mediaId)]);

export const historyEntry = pgTable("history_entry", {
  id: text("id").primaryKey(),
  mediaType: text("media_type").notNull(),
  mediaId: text("media_id").notNull(),
  action: text("action").notNull(),
  data: jsonb("data").$type<Record<string, unknown>>().notNull(),
  createdAt: iso("created_at"),
}, (t) => [index("history_media_idx").on(t.mediaType, t.mediaId), index("history_created_idx").on(t.createdAt)]);

export const blocklistEntry = pgTable("blocklist_entry", {
  id: text("id").primaryKey(),
  mediaType: text("media_type").notNull(),
  mediaId: text("media_id").notNull(),
  indexerId: text("indexer_id"),
  title: text("title").notNull(),
  torrentInfohash: text("torrent_infohash"),
  reason: text("reason"),
  createdAt: iso("created_at"),
});

// ---------- 6. Media availability ----------
export const mediaAvailability = pgTable("media_availability", {
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

export const mediaServer = pgTable("media_server", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  implementation: text("implementation").notNull(),
  kind: text("kind").notNull().default("media"),
  enabled: bool("enabled", true),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull(),
  createdAt: iso("created_at"),
  updatedAt: iso("updated_at"),
});

export const notification = pgTable("notification", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  enabled: bool("enabled", true),
  eventTypes: json<string[]>("event_types"),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull(),
  createdAt: iso("created_at"),
  updatedAt: iso("updated_at"),
});

// ---------- 7. Jobs ----------
export const jobDefinition = pgTable("job_definition", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  schedule: text("schedule").notNull(),
  enabled: bool("enabled", true),
  timeoutMs: integer("timeout_ms").notNull().default(60_000),
  maxRetries: integer("max_retries").notNull().default(2),
  retryBackoffMs: integer("retry_backoff_ms").notNull().default(5_000),
  priority: integer("priority").notNull().default(100),
  concurrencyLimit: integer("concurrency_limit").notNull().default(1),
  lastExecutedAt: nullableIso("last_executed_at"),
  createdAt: iso("created_at"),
  updatedAt: iso("updated_at"),
});

export const jobRun = pgTable("job_run", {
  id: text("id").primaryKey(),
  jobKey: text("job_key").notNull(),
  status: text("status").notNull().default("queued"),
  trigger: text("trigger").notNull().default("scheduled"),
  attempt: integer("attempt").notNull().default(1),
  progress: integer("progress").notNull().default(0),
  message: text("message"),
  error: text("error"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(sql`'{}'`),
  result: nullableJson<Record<string, unknown>>("result"),
  correlationId: text("correlation_id"),
  dueAt: text("due_at"),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
  createdAt: iso("created_at"),
}, (t) => [index("jobrun_key_idx").on(t.jobKey), index("jobrun_status_idx").on(t.status), index("jobrun_created_idx").on(t.createdAt)]);

// ---------- 8. Observability ----------
export const auditLog = pgTable("audit_log", {
  id: text("id").primaryKey(),
  correlationId: text("correlation_id"),
  actor: text("actor").notNull().default("system"),
  action: text("action").notNull(),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  details: jsonb("details").$type<Record<string, unknown>>().notNull().default(sql`'{}'`),
  ip: text("ip"),
  createdAt: iso("created_at"),
}, (t) => [index("audit_created_idx").on(t.createdAt), index("audit_entity_idx").on(t.entityType, t.entityId)]);

export const eventOutbox = pgTable("event_outbox", {
  // Postgres `serial` = auto-incrementing integer, the native equivalent of SQLite's
  // `integer primary key autoincrement`.
  seq: serial("seq").primaryKey(),
  id: text("id").notNull(),
  type: text("type").notNull(),
  version: integer("version").notNull(),
  occurredAt: text("occurred_at").notNull(),
  correlationId: text("correlation_id").notNull(),
  aggregate: json<Record<string, unknown>>("aggregate").notNull(),
  payload: json("payload").notNull(),
}, (t) => [
  uniqueIndex("event_outbox_id_idx").on(t.id),
  index("event_outbox_occurred_idx").on(t.occurredAt),
]);

export const healthCheckResult = pgTable("health_check_result", {
  id: text("id").primaryKey(),
  key: text("key").notNull(),
  ok: bool("ok", true),
  level: text("level").notNull(),
  message: text("message").notNull(),
  checkedAt: iso("checked_at"),
}, (t) => [uniqueIndex("health_check_result_key_idx").on(t.key)]);

export const providerStatus = pgTable("provider_status", {
  id: text("id").primaryKey(),
  providerType: text("provider_type").notNull(),
  providerId: text("provider_id").notNull(),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  escalationLevel: integer("escalation_level").notNull().default(0),
  disabledUntil: nullableIso("disabled_until"),
  autoDisabled: bool("auto_disabled", false),
  lastError: text("last_error"),
  lastFailureAt: nullableIso("last_failure_at"),
  lastSuccessAt: nullableIso("last_success_at"),
  rateLimit: json<Record<string, { count: number; windowStart: number }> | null>("rate_limit"),
  updatedAt: iso("updated_at"),
}, (t) => [
  uniqueIndex("provider_status_type_id_idx").on(t.providerType, t.providerId),
]);

// ---------- exported schema ----------
export const schema = {
  apiKey,
  adminCredential,
  setting,
  qualityProfile,
  qualityDefinition,
  customFormat,
  rootFolder,
  movie,
  series,
  season,
  episode,
  mediaFile,
  indexerDefinition,
  indexer,
  seenRelease,
  downloadClient,
  remotePathMapping,
  downloadQueueEntry,
  historyEntry,
  blocklistEntry,
  mediaAvailability,
  mediaServer,
  notification,
  jobDefinition,
  jobRun,
  auditLog,
  eventOutbox,
  healthCheckResult,
  providerStatus,
  tag,
  importList,
  importExclusion,
};

export type Schema = typeof schema;
