// SPDX-License-Identifier: MIT
/**
 * MediaNexus unified storage schema (Drizzle, SQLite dialect).
 * Derives from docs/architecture/domain-model.md — that document is the source of truth.
 *
 * NOTE: SQLite is the fully-wired default. PostgreSQL is a targeted follow-up: Drizzle's
 * pg-core port of this schema is a contained, mechanical change (see roadmap M1.1).
 */
import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql, type SQL } from "drizzle-orm";
import type { CustomFormatSpec, AutoTagSpec } from "@medianexus/domain";

// ---------- helpers ----------
const iso = (name: string) => text(name).notNull();
const nullableIso = (name: string) => text(name);
const bool = (name: string, def: boolean) =>
  integer(name, { mode: "boolean" }).notNull().default(def);
const json = <T,>(name: string, def: SQL = sql`'[]'`) =>
  text(name, { mode: "json" }).$type<T>().notNull().default(def);

// ---------- 1. Identity & access ----------
// Single-tier auth: any valid API key is a system/admin key (arr-style). No user
// accounts/roles — this app is never public-facing.
export const apiKey = sqliteTable("api_key", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull(), // sha256 of the raw key — used for O(1) auth lookups
  encryptedKey: text("encrypted_key"), // raw key, AES-256-GCM encrypted with MEDIA_NEXUS_SECRET — lets System settings reveal it later without regenerating; null for keys minted before this column existed
  scopes: json<string[]>("scopes", sql`'[]'`),
  lastUsedAt: nullableIso("last_used_at"),
  expiresAt: nullableIso("expires_at"),
  createdAt: iso("created_at"),
}, (t) => [uniqueIndex("api_key_hash_idx").on(t.keyHash)]);

// Single admin credential (login/session auth for the browser, arr-style Forms auth).
// Singleton row (id is always "admin"); separate from apiKey, which stays for external/compat clients.
export const adminCredential = sqliteTable("admin_credential", {
  id: text("id").primaryKey(),
  username: text("username").notNull(),
  passwordHash: text("password_hash").notNull(), // scrypt: "salt:hash" hex
  passwordVersion: integer("password_version").notNull().default(1), // bumped on password change; embedded in session cookies to invalidate old sessions
  createdAt: iso("created_at"),
  updatedAt: iso("updated_at"),
});

// ---------- 2. Configuration ----------
export const setting = sqliteTable("setting", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).$type<unknown>().notNull(),
  updatedAt: iso("updated_at"),
});

// Shared quality profiles (movies + series). `items` is an ordered list of
// quality registry ids (worst to best, upstream convention); `cutoffQualityId`
// is one of them. See packages/domain/src/quality.ts for the registry and the
// comparator that consumes this shape (roadmap P0.2).
export const qualityProfile = sqliteTable("quality_profile", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  items: json<number[]>("items"),
  cutoffQualityId: integer("cutoff_quality_id").notNull().default(0),
  upgradeAllowed: bool("upgrade_allowed", true),
  language: text("language").notNull().default("en"),
  isDefault: bool("is_default", false),
  // Custom-format scoring (roadmap P2, gap report B4/D6): per-format scores keyed by
  // custom format id + grab/min and upgrade/cutoff format-score thresholds. Absent/0
  // means format behavior is inert, matching every profile today.
  formatScores: json<Record<string, number>>("format_scores", sql`'{}'`),
  minFormatScore: integer("min_format_score").notNull().default(0),
  cutoffFormatScore: integer("cutoff_format_score").notNull().default(0),
  createdAt: iso("created_at"),
  updatedAt: iso("updated_at"),
});

// Per-quality size limits (min/max/preferred, MB per runtime-minute — upstream's
// convention). `id` is the quality registry id from packages/domain/src/quality.ts,
// not a newEntityId-prefixed row — it is a stable reference id, not an entity.
// Seeded with sensible defaults; consumed by the decision engine's size
// specification (roadmap P0.3) — not read anywhere yet as of this table landing.
export const qualityDefinition = sqliteTable("quality_definition", {
  id: integer("id").primaryKey(),
  title: text("title").notNull(),
  minSize: integer("min_size"), // MB per runtime-minute; null = no minimum
  maxSize: integer("max_size"), // MB per runtime-minute; null = unlimited
  preferredSize: integer("preferred_size"), // MB per runtime-minute; null = no preference
  updatedAt: iso("updated_at"),
});

// Custom-format catalog (roadmap P2, gap report B4/D6). A named collection of release
// matching specs (term/regex, size, language, indexer). `specs` is JSON; the concrete
// per-spec shape is validated by packages/domain/src/custom-formats.ts. Profiles reference
// formats by id through quality_profile.format_scores, so deleting a format here can
// orphan a score key entry but never crashes a decision (absent keys score 0).
export const customFormat = sqliteTable("custom_format", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  specs: json<CustomFormatSpec[]>("specs").notNull(),
  createdAt: iso("created_at"),
  updatedAt: iso("updated_at"),
});

// Root folders (roadmap P1, gap report B8): promotes the single-array paths.rootFolders
// setting to a real, per-title-assignable entity. Accessibility and free space are runtime
// probes (LocalStorageProvider.diskFree), not persisted — only identity and the default
// flags live here. The default is per media type (ROOTFOLDER-1): a folder can be the
// default for movies, for series, both, or neither — a root folder is a generic path
// usable for either type. At most one row may be true per type; RootFoldersService
// enforces that (a plain column can't express "at most one true" on its own).
export const rootFolder = sqliteTable("root_folder", {
  id: text("id").primaryKey(),
  path: text("path").notNull(),
  name: text("name").notNull().default(""),
  isDefaultMovie: bool("is_default_movie", false),
  isDefaultSeries: bool("is_default_series", false),
  createdAt: iso("created_at"),
}, (t) => [uniqueIndex("root_folder_path_idx").on(t.path)]);

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
  // Detail-page metadata (roadmap P3 / DETAILPAGE-BE1): nullable columns populated by
  // metadata refresh; existing rows hold null until next refresh. `releaseDate` stays as-is
  // (back-compat); the three new dates carry the fuller in-cinemas/digital/physical split.
  certification: text("certification"),
  runtime: integer("runtime"), // minutes
  studio: text("studio"), // production company, movies only
  inCinemas: text("in_cinemas"), // ISO date
  digitalRelease: text("digital_release"), // ISO date
  physicalRelease: text("physical_release"), // ISO date
  trailerId: text("trailer_id"), // YouTube video id
  tmdbRating: real("tmdb_rating"), // vote_average
  // Collection the movie belongs to (roadmap P3 / DETAILPAGE-BE3) — deliberately two nullable
  // columns on `movie`, NOT a joined movie_collection table: the mockup shows only a text chip
  // ("Dune Collection") beside the genres. A join table is the right shape only when
  // "browse other movies in this collection" gets built; promoting these two columns then is a
  // normal, cheap migration. Absent = null (most movies aren't in a collection).
  collectionTmdbId: integer("collection_tmdb_id"),
  collectionName: text("collection_name"),
  qualityProfileId: text("quality_profile_id").references(() => qualityProfile.id, { onDelete: "set null" }),
  rootFolderPath: text("root_folder_path").notNull().default(""),
  minimumAvailability: text("minimum_availability").notNull().default("announced"),
  // Folder-name override (gap report B3 / Library Import): when a title's files live in a
  // non-conventional on-disk folder, this stores the exact folder NAME (last path segment) so
  // import/scan/delete resolve it instead of the movieFolderName() "Title (YYYY)" convention.
  // Null = use the convention. Validated server-side (a real path-traversal surface otherwise,
  // since it feeds join(rootFolderPath, folderName)); see createMovieSchema/updateMovieSchema.
  folderName: text("folder_name"),
  genres: json<string[]>("genres"),
  images: json<Record<string, string>[]>("images"),
  tags: json<string[]>("tags"),
  hasFile: bool("has_file", false),
  addedAt: iso("added_at"),
  updatedAt: iso("updated_at"),
  lastRefreshedAt: nullableIso("last_refreshed_at"),
}, (t) => [uniqueIndex("movie_tmdb_idx").on(t.tmdbId)]);

export const series = sqliteTable("series", {
  id: text("id").primaryKey(),
  tvdbId: integer("tvdb_id"),
  tmdbId: integer("tmdb_id"), // secondary id (identity stays tvdbId) — enables discover "in library" matching
  imdbId: text("imdb_id"),
  title: text("title").notNull(),
  overview: text("overview").notNull().default(""),
  status: text("status").notNull().default("unknown"),
  seriesType: text("series_type").notNull().default("standard"),
  network: text("network"),
  firstAirYear: integer("first_air_year"),
  monitored: bool("monitored", true),
  // Detail-page metadata (roadmap P3 / DETAILPAGE-BE1) — movies absent: no studio/release-date
  // breakdown for series (firstAirYear already covers release timing; Radarr's release-date
  // split is movie-specific).
  certification: text("certification"),
  runtime: integer("runtime"), // minutes (episode runtime)
  trailerId: text("trailer_id"), // YouTube video id
  tmdbRating: real("tmdb_rating"), // vote_average
  qualityProfileId: text("quality_profile_id").references(() => qualityProfile.id, { onDelete: "set null" }),
  rootFolderPath: text("root_folder_path").notNull().default(""),
  // Folder-name override (gap report B3 / Library Import) — series variant: stores the exact
  // on-disk folder NAME when it isn't the seriesFolderName() convention. Null = use convention.
  // Same validation as movies (see inputs.ts). Feeds join(rootFolderPath, folderName).
  folderName: text("folder_name"),
  genres: json<string[]>("genres"),
  images: json<Record<string, string>[]>("images"),
  tags: json<string[]>("tags"),
  alternateTitles: json<string[]>("alternate_titles"),
  addedAt: iso("added_at"),
  updatedAt: iso("updated_at"),
  lastRefreshedAt: nullableIso("last_refreshed_at"),
}, (t) => [uniqueIndex("series_tvdb_idx").on(t.tvdbId), uniqueIndex("series_tmdb_idx").on(t.tmdbId)]);

export const season = sqliteTable("season", {
  id: text("id").primaryKey(),
  seriesId: text("series_id").notNull().references(() => series.id, { onDelete: "cascade" }),
  seasonNumber: integer("season_number").notNull(),
  monitored: bool("monitored", true),
}, (t) => [
  uniqueIndex("season_series_num_idx").on(t.seriesId, t.seasonNumber),
  index("season_series_idx").on(t.seriesId),
]);

export const episode = sqliteTable("episode", {
  id: text("id").primaryKey(),
  seriesId: text("series_id").notNull().references(() => series.id, { onDelete: "cascade" }),
  seasonId: text("season_id").notNull().references(() => season.id, { onDelete: "cascade" }),
  episodeNumber: integer("episode_number").notNull(),
  absoluteNumber: integer("absolute_number"),
  // TMDB episode_type (EPISODEDETAIL-1): "standard" | "finale" | "mid_season" | "premiere" — drives
  // the Series Finale / Midseason Finale badges. Null until a post-migration metadata refresh.
  episodeType: text("episode_type"),
  title: text("title").notNull().default(""),
  overview: text("overview").notNull().default(""),
  airDateUtc: text("air_date_utc"),
  monitored: bool("monitored", true),
  hasFile: bool("has_file", false),
  // Back-reference to the media_file that covers this episode (gap report J3): the indexed,
  // queryable inverse of media_file.episode_ids. An episode losing its file must NOT cascade the
  // episode away — SET NULL keeps the row (family history) and just drops the file pointer.
  mediaFileId: text("media_file_id").references(() => mediaFile.id, { onDelete: "set null" }),
  sceneSeasonNumber: integer("scene_season_number"),
  sceneEpisodeNumber: integer("scene_episode_number"),
}, (t) => [
  index("episode_series_idx").on(t.seriesId),
  index("episode_season_idx").on(t.seasonId),
  index("episode_media_file_idx").on(t.mediaFileId),
]);

export const mediaFile = sqliteTable("media_file", {
  id: text("id").primaryKey(),
  mediaType: text("media_type").notNull(), // movie | series
  mediaId: text("media_id").notNull(), // movie.id | series.id
  relativePath: text("relative_path").notNull(),
  size: integer("size").notNull().default(0),
  quality: json<{ source: string; resolution: string; edition: string }>("quality"),
  mediaInfo: json<Record<string, unknown>>("media_info"),
  languages: json<string[]>("languages"),
  releaseGroup: text("release_group"),
  // Indexer-flag bitmask (MANAGEFILES-1): a single int holding the OR'd bits of
  // NzbDrone.Core.Parser.Model.IndexerFlags (freeleech=1 … subtitles=256). Flat column
  // matches upstream's own storage model and media_file's existing flat-column convention.
  indexerFlags: integer("indexer_flags").notNull().default(0),
  // Series-only release shape (MANAGEFILES-1): single | multi | season, set via the Manage
  // Episodes table's Release Type picker. Null = unknown. Movies never carry a release type.
  releaseType: text("release_type"),
  dateAdded: iso("date_added"),
}, (t) => [index("media_file_media_idx").on(t.mediaType, t.mediaId)]);

// Cast & crew for a movie or series (roadmap P3 / DETAILPAGE-BE2). Polymorphic — serves both
// media types through the shared `(mediaType, mediaId)` pattern (same as media_file/queue/
// history/availability). The TMDB credits response splits cast (all of it — `order` lets a
// consumer slice top-N for the mockup's scrollable strip) from a curated crew subset (only key
// jobs, e.g. Director/Writer/Screenplay/Creator, not best-boy grips and script supervisors).
// `character` is cast-only, `job`/`department` crew-only, `sortOrder` mirrors TMDB's cast `order`.
export const mediaCredit = sqliteTable("media_credit", {
  id: text("id").primaryKey(), // newEntityId("credit")
  mediaType: text("media_type").notNull(), // movie | series
  mediaId: text("media_id").notNull(), // movie.id | series.id
  role: text("role").notNull(), // cast | crew
  personName: text("person_name").notNull(),
  character: text("character"), // cast only
  job: text("job"), // crew only
  department: text("department"), // crew only
  sortOrder: integer("sort_order"), // TMDB cast `order`; cast only
  profileUrl: text("profile_url"), // w185 headshot; null when TMDB has no photo
}, (t) => [index("media_credit_media_idx").on(t.mediaType, t.mediaId)]);

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
  capabilities: text("capabilities", { mode: "json" }).$type<Record<string, unknown> | null>(),
  // Session/cookie state for Cardigann indexers (roadmap D4, Stage 1). An opaque, plain-text
  // placeholder: there is no write path to persist a session yet, so nothing here is encrypted.
  // The J9 AES-256-GCM codec (@medianexus/shared crypto.ts) is wired in when the Stage 2 login
  // engine adds the DB write/read path. For now it lets a provider's session value round-trip
  // through the DB via the CardigannProvider accessor (there is no in-memory provider cache for
  // indexers the way download-clients have clientCache). Null until a provider sets it.
  sessionState: text("session_state"),
  tags: json<string[]>("tags"),
  createdAt: iso("created_at"),
  updatedAt: iso("updated_at"),
});

// Seen-release cache (roadmap D2, real RSS sync): a category-only "recent releases" poll
// against an indexer returns a heavily-overlapping set on every tick (feeds have a rolling
// window; polls run every few minutes). This is what lets a poll skip re-parsing/re-matching
// releases it already evaluated, independent of whether a release ever matched anything —
// a separate concern from download_queue_entry/history_entry's "don't re-grab this title"
// dedupe. Pruned inline by the poll itself; no separate housekeeping job.
export const seenRelease = sqliteTable("seen_release", {
  id: text("id").primaryKey(),
  indexerId: text("indexer_id").notNull().references(() => indexer.id, { onDelete: "cascade" }),
  guid: text("guid").notNull(), // Release.id — provider-assigned stable id
  firstSeenAt: iso("first_seen_at"),
}, (t) => [
  uniqueIndex("seen_release_indexer_guid_idx").on(t.indexerId, t.guid),
  index("seen_release_first_seen_idx").on(t.firstSeenAt),
]);

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

// ---------- Tag catalog (roadmap P2, gap report C6) ----------
// A user-facing tag catalog. Entity `tags` columns (movie, series, indexer,
// download_client) reference tag IDs (stable keys), so renaming a tag's label/color never
// orphans the arrays. The table is a catalog only — the arrays stay free-form — and
// tag-based routing (indexer scoping / download-client routing) matches on the strings.
export const tag = sqliteTable("tag", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  color: text("color"),
  createdAt: iso("created_at"),
  updatedAt: iso("updated_at"),
});

// ---------- Release profiles (roadmap P3, gap report C6) ----------
// Tag-scoped hard required/ignored term restrictions for the decision engine. `required` and
// `ignored` are Sonarr TermMatcherService-style terms (plain substring or /regex/); `tags` is the
// media tag scope (empty = applies to all media). Reject-only — scored/"preferred" terms are Custom
// Formats' job (see packages/domain/src/release-profile.ts). See also ADR-004-era divergence note:
// this scopes by the unified tag mechanism only, no separate indexer-id axis.
export const releaseProfile = sqliteTable("release_profile", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  enabled: bool("enabled", true),
  required: json<string[]>("required").notNull(),
  ignored: json<string[]>("ignored").notNull(),
  tags: json<string[]>("tags").notNull(),
  createdAt: iso("created_at"),
  updatedAt: iso("updated_at"),
});

// ---------- Auto-tagging (roadmap P3, gap report C6) ----------
// Rules that automatically apply/remove tags on movie/series rows based on typed conditions
// (genre, status, network, ...), mirroring upstream AutoTag. `specifications` is an array of
// discriminated-union spec objects (see packages/domain/src/auto-tag.ts).
export const autoTag = sqliteTable("auto_tag", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  removeTagsAutomatically: bool("remove_tags_automatically", false),
  tags: json<string[]>("tags").notNull(),
  specifications: json<AutoTagSpec[]>("specifications").notNull(),
  createdAt: iso("created_at"),
  updatedAt: iso("updated_at"),
});

// ---------- Import lists (roadmap P2, gap report C2) ----------
// A generic watchlist-sync subsystem. `import_list` is a configured list source (provider
// type + credentials/config, e.g. a TMDB list id); a recurring `media.importLists` job
// pulls its items and adds any not already in the library (monitored). `import_exclusion`
// is the "don't re-add" set — recorded when a user removes a library title by hand so the
// next sync doesn't silently re-import it.
export const importList = sqliteTable("import_list", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(), // "tmdb" | "trakt" | "plex" (first pass: tmdb)
  name: text("name").notNull(),
  enabled: bool("enabled", true).notNull().default(true),
  config: text("config", { mode: "json" }).$type<Record<string, unknown>>().notNull(), // e.g. { listId }
  lastSyncAt: text("last_synced_at"),
  lastError: text("last_error"),
  createdAt: iso("created_at"),
  updatedAt: iso("updated_at"),
});

export const importExclusion = sqliteTable("import_exclusion", {
  id: text("id").primaryKey(),
  mediaType: text("media_type").notNull(), // movie | series
  externalId: text("external_id").notNull(), // tmdbId as string (provider-scoped id)
  reason: text("reason"),
  // Resolved ONCE at write time (IMPORTEXCLTITLE-1) so the exclusions list shows a real title
  // instead of a raw id — null when nothing could be resolved (legacy rows, failed lookups). Not
  // re-fetched on read: captured by the removal path for free, via one TMDB call for manual adds.
  title: text("title"),
  year: integer("year"),
  createdAt: iso("created_at"),
}, (t) => [
  uniqueIndex("import_exclusion_media_ext_idx").on(t.mediaType, t.externalId),
]);

// ---------- Collections (UNI-021) ----------
// One part of a TMDB movie collection, denormalized into `collection.parts` (a JSON column,
// same convention as movie.images/genres — not a separate relational table). `inLibrary` /
// `libraryId` are recomputed on every sync; missing-count is parts with inLibrary false,
// computed at read/sync time, not stored.
export interface CollectionPart {
  tmdbId: number;
  title: string;
  releaseDate: string | null;
  images: { coverType: string; url: string }[];
  inLibrary: boolean;
  libraryId: string | null;
}

export const collection = sqliteTable("collection", {
  id: text("id").primaryKey(),
  tmdbId: integer("tmdb_id").notNull(),
  name: text("name").notNull(),
  overview: text("overview"),
  images: json<{ coverType: string; url: string }[]>("images"),
  monitored: bool("monitored", false),
  qualityProfileId: text("quality_profile_id").references(() => qualityProfile.id, { onDelete: "set null" }),
  rootFolderPath: text("root_folder_path").notNull().default(""),
  minimumAvailability: text("minimum_availability").notNull().default("released"),
  searchOnAdd: bool("search_on_add", false),
  parts: json<CollectionPart[]>("parts"),
  lastSyncAt: nullableIso("last_sync_at"),
  createdAt: iso("created_at"),
  updatedAt: iso("updated_at"),
}, (t) => [uniqueIndex("collection_tmdb_idx").on(t.tmdbId)]);

// ---------- 5. Acquisition ----------
// Remote path mapping (roadmap P1, gap report B8): translates a download client's
// self-reported content path (e.g. /downloads/x inside its own container) into the path
// MediaNexus sees on its own filesystem. Applied in
// AcquisitionService.resolveContent() before a completed download's content is located.
export const remotePathMapping = sqliteTable("remote_path_mapping", {
  id: text("id").primaryKey(),
  downloadClientId: text("download_client_id").notNull().references(() => downloadClient.id, { onDelete: "cascade" }),
  remotePath: text("remote_path").notNull(),
  localPath: text("local_path").notNull(),
  createdAt: iso("created_at"),
}, (t) => [
  uniqueIndex("remote_path_mapping_client_remote_idx").on(t.downloadClientId, t.remotePath),
  index("remote_path_mapping_client_idx").on(t.downloadClientId),
]);

export const downloadQueueEntry = sqliteTable("download_queue_entry", {
  id: text("id").primaryKey(),
  mediaType: text("media_type").notNull(),
  mediaId: text("media_id").notNull(),
  downloadClientId: text("download_client_id").references(() => downloadClient.id, { onDelete: "set null" }),
  downloadId: text("download_id"), // client-side id
  title: text("title").notNull(),
  status: text("status").notNull().default("queued"),
  progress: integer("progress").notNull().default(0),
  size: integer("size").notNull().default(0),
  remainingTime: integer("remaining_time"),
  errorMessage: text("error_message"),
  data: text("data", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
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

// ---------- 6. Media availability ----------
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

export const mediaServer = sqliteTable("media_server", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  implementation: text("implementation").notNull(),
  kind: text("kind").notNull().default("media"),
  enabled: bool("enabled", true),
  settings: text("settings", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  createdAt: iso("created_at"),
  updatedAt: iso("updated_at"),
});

// Notification sinks (roadmap P2, gap report J4/D7): promoted from JSON arrays in the
// `setting` blob (notifications.webhooks/discord/telegram/email, addressed by array
// index) to a real entity with a stable id — same shape as `downloadClient`. `kind` is
// webhook|discord|telegram|email; `settings` holds the kind-specific fields only
// (webhook->{url,secret}, discord->{webhookUrl}, telegram->{botToken,chatId,baseUrl},
// email->{from,to,transport,subject}); `eventTypes` is hoisted to its own column so the
// fan-out filter is a plain WHERE rather than JSON digging. Legacy `setting` rows are
// migrated by `settings-blob-backfill.ts` on boot (sentinel-gated, non-destructive).
export const notification = sqliteTable("notification", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(), // webhook | discord | telegram | email
  name: text("name").notNull(),
  enabled: bool("enabled", true),
  eventTypes: json<string[]>("event_types"),
  settings: text("settings", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  createdAt: iso("created_at"),
  updatedAt: iso("updated_at"),
});

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
  // Persisted so schedule due-ness survives a restart (roadmap P1, gap report B11) —
  // previously tracked only in an in-process Map, so a restart silently skipped overdue work.
  lastExecutedAt: nullableIso("last_executed_at"),
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

// Durable event outbox (roadmap P2, gap H6): persists every domain event so audit + SSE
// replay survive crashes/restarts. `seq` is the monotonic order key (rowid autoincrement);
// `id` carries the DomainEvent's stable uuid used as the SSE `Last-Event-ID` cursor.
export const eventOutbox = sqliteTable("event_outbox", {
  seq: integer("seq").primaryKey({ autoIncrement: true }),
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

// Health check registry (roadmap P1, gap report B9): persisted results of the
// system.healthCheck job's run, one row per check key, upserted on every run so results
// survive between runs and can be read without re-running (GET /api/v1/system/health).
export const healthCheckResult = sqliteTable("health_check_result", {
  id: text("id").primaryKey(),
  key: text("key").notNull(),
  ok: bool("ok", true),
  level: text("level").notNull(), // ok | warning | error
  message: text("message").notNull(),
  checkedAt: iso("checked_at"),
}, (t) => [uniqueIndex("health_check_result_key_idx").on(t.key)]);

// Generic per-provider health/backoff/rate-limit state (roadmap P1, gap report B10).
// One row per (providerType, providerId); generic across indexers + download clients and
// later notifications/import lists, so the backoff/auto-disable/rate-limit machinery is
// shared rather than duplicated per provider kind. Keyed by a plain providerId string (no
// FK — the referent lives in indexer or download_client depending on providerType, and the
// table must stay generic for future kinds). Not a hard-disable: `enabled` on the provider
// row itself is untouched; auto-disabled providers are skipped by the call sites in
// ProviderStatusService and re-enabled via the manual test()/healthcheck recovery path.
export const providerStatus = sqliteTable("provider_status", {
  id: text("id").primaryKey(),
  providerType: text("provider_type").notNull(), // indexer | downloadClient
  providerId: text("provider_id").notNull(),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  escalationLevel: integer("escalation_level").notNull().default(0),
  disabledUntil: nullableIso("disabled_until"), // null = not backed off
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
  mediaCredit,
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
  releaseProfile,
  autoTag,
  importList,
  importExclusion,
  collection,
};

export type Schema = typeof schema;
