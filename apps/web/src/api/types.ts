// SPDX-License-Identifier: MIT
type MinimumAvailability = "announced" | "in_cinemas" | "released" | "deleted";

export interface Movie {
  id: string;
  tmdbId: number | null;
  imdbId: string | null;
  title: string;
  overview: string;
  status: string;
  releaseDate: string | null;
  monitored: boolean;
  // Detail-page metadata (DETAILPAGE-BE1) — nullable; populated by metadata refresh.
  certification: string | null;
  runtime: number | null; // minutes
  studio: string | null; // movies only
  inCinemas: string | null; // ISO date
  digitalRelease: string | null; // ISO date
  physicalRelease: string | null; // ISO date
  trailerId: string | null; // YouTube video id
  tmdbRating: number | null; // vote_average
  collectionTmdbId: number | null; // movie collection (DETAILPAGE-BE3), null when none
  collectionName: string | null;
  qualityProfileId: string | null;
  rootFolderPath: string;
  minimumAvailability: MinimumAvailability;
  genres: string[];
  images: { coverType: string; url: string }[];
  tags: string[];
  hasFile: boolean;
  addedAt: string;
}

export interface Series {
  id: string;
  tvdbId: number | null;
  tmdbId: number | null;
  imdbId: string | null;
  title: string;
  overview: string;
  status: string;
  seriesType: string;
  firstAirYear: number | null;
  monitored: boolean;
  // Detail-page metadata (DETAILPAGE-BE1) — nullable; populated by metadata refresh.
  certification: string | null;
  runtime: number | null; // minutes (episode runtime)
  trailerId: string | null; // YouTube video id
  tmdbRating: number | null; // vote_average
  network: string | null;
  genres: string[];
  images: { coverType: string; url: string }[];
  tags: string[];
  rootFolderPath: string;
  addedAt: string;
}

export interface Episode {
  id: string;
  seriesId: string;
  seasonId: string;
  episodeNumber: number;
  absoluteNumber: number | null;
  title: string;
  airDateUtc: string | null;
  monitored: boolean;
  hasFile: boolean;
}

interface WantedEpisode extends Episode {
  seasonNumber: number;
  seriesTitle: string;
}
interface WantedEpisodeRow extends WantedEpisode {
  mediaType: "series";
}

interface WantedMovieRow {
  mediaType: "movie";
  id: string;
  title: string;
  releaseDate: string | null;
  minimumAvailability: MinimumAvailability;
  monitored: boolean;
  hasFile: boolean;
}

/** GET /wanted/missing returns a merge of both (roadmap C1). */
export type WantedItem = WantedMovieRow | WantedEpisodeRow;

export type CalendarEntry =
  | {
      mediaType: "episode";
      id: string;
      seriesId: string;
      seriesTitle: string;
      seasonNumber: number;
      episodeNumber: number;
      title: string;
      airDateUtc: string;
      hasFile: boolean;
      monitored: boolean;
    }
  | {
      mediaType: "movie";
      movieId: string;
      movieTitle: string;
      releaseDate: string;
      hasFile: boolean;
      monitored: boolean;
    };

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface SystemStatus {
  appName: string;
  version: string;
  started: string;
  uptimeSeconds: number;
  database: { vendor: string };
}

interface UpdateCheckResult {
  checked: true;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  checkedAt: string;
}

interface UpdateCheckNotChecked {
  checked: false;
  currentVersion: string;
  latestVersion: null;
  updateAvailable: false;
  releaseUrl: null;
  checkedAt: null;
}

export type UpdateCheckState = UpdateCheckResult | UpdateCheckNotChecked;

export interface HistoryRow {
  id: string;
  mediaType: string;
  mediaId: string;
  action: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface QueueRow {
  id: string;
  mediaType: string;
  mediaId: string;
  downloadId: string | null;
  title: string;
  status: string;
  progress: number;
  size: number;
  addedAt: string;
}

export interface Release {
  id: string;
  indexerId: string;
  indexerName: string;
  title: string;
  protocol: string;
  size: number;
  seeders: number | null;
  quality: { source: string; resolution: string };
  /** Attached by DecisionService to POST /search results (DETAILPAGE-FE1): rejected releases
   *  carry their reasons here (with a Rejected flag in the UI + a working Grab only when
   *  approved). undefined when the search response doesn't include a decision. */
  decision?: { approved: boolean; rejections: { reason: string; message: string }[]; profile?: number; formatScore?: number } | undefined;
}

export interface IndexerDef {
  id: string;
  key: string;
  name: string;
  protocol: string;
  implementation: string;
  builtIn: boolean;
  capabilities?: { cardigannStatus?: { supported: boolean; reasons: string[] } } | null;
}

export interface DownloadClient {
  id: string;
  name: string;
  implementation: string;
  kind: string;
  enabled: boolean;
  priority: number;
  settings: Record<string, unknown>;
  tags: string[];
  createdAt: string;
}

export interface RootFolder {
  id: string;
  path: string;
  name: string;
  isDefault: boolean;
  createdAt: string;
  accessible: boolean;
  freeBytes: number | null;
  totalBytes: number | null;
}

/** A single cast-or-crew credit (DETAILPAGE-BE2). `character` cast-only, `job`/`department`
 *  crew-only, `sortOrder` cast billing order (0 = top-billed), `profileUrl` may be null. */
export interface Credit {
  id: string;
  mediaType: "movie" | "series";
  mediaId: string;
  role: "cast" | "crew";
  personName: string;
  character: string | null;
  job: string | null;
  department: string | null;
  sortOrder: number | null;
  profileUrl: string | null;
}

/** GET /movies/:id/credits and /series/:id/credits — split by role, cast ordered top-billed. */
export interface CreditsResponse {
  cast: Credit[];
  crew: Credit[];
}

/** A media_file row as exposed by GET /movies|series/:id/files (DETAILPAGE-FE1). episodeIds is
 *  populated for series files only; a movie has none. mediaInfo/quality may be null before a
 *  probe/refresh runs. */
export interface MediaFileRow {
  id: string;
  mediaType: "movie" | "series";
  mediaId: string;
  episodeIds: string[];
  relativePath: string;
  size: number;
  quality: { source: string; resolution: string; edition: string } | null;
  mediaInfo: {
    videoCodec: string | null;
    audioCodec: string | null;
    resolution: string | null;
    runtimeSeconds: number | null;
    audioChannels: number | null;
    subtitles: { language: string | null }[];
  } | null;
  languages: string[];
  releaseGroup: string | null;
  dateAdded: string | null;
}

/** One row of GET /movies|series/:id/rename-preview (DETAILPAGE-BE4/FE1). */
export interface RenamePreviewItem {
  mediaFileId: string;
  currentPath: string;
  newPath: string;
  changed: boolean;
}

/** The wrapped rename-preview response (FILEMGMT-1) — the title's resolved folder path and its
 *  naming template, so the panel can render its info lines. */
export interface RenamePreviewEnvelope {
  rootPath: string;
  namingPattern: string;
  items: RenamePreviewItem[];
}

/** One untracked file in a Manage Files/Episodes scan preview (FILEMGMT-2). For series,
 *  `episodeIds` is set when the file matched (its import checkbox is enabled), `rejections` when
 *  it didn't match/quality-gate (shown instead), and `supersedes` lists the tracked files it
 *  would replace when imported (an explicit, visible consequence before the user opts in). */
export interface ScanUntrackedFile {
  path: string;
  relativePath: string;
  size: number;
  quality: { source: string; resolution: string; edition: string };
  episodeIds?: string[];
  rejections?: { reason: string; message: string }[];
  supersedes?: { mediaFileId: string; relativePath: string }[];
}

/** GET /movies|series/:id/manage-files — what differs between disk and the DB, the input to the
 *  Manage Files/Episodes modal. */
export interface ScanPreview {
  stale: { mediaFileId: string; relativePath: string }[];
  untracked: ScanUntrackedFile[];
}

export interface RemotePathMapping {
  id: string;
  downloadClientId: string;
  remotePath: string;
  localPath: string;
  createdAt: string;
}

export interface IndexerRow {
  id: string;
  definitionKey: string;
  name: string;
  protocol: string;
  enabled: boolean;
  implementation: string;
  status: string;
  lastError?: string | null;
}

export interface JobRun {
  id: string;
  jobKey: string;
  status: string;
  trigger: string;
  attempt: number;
  progress: number;
  message?: string;
  error?: string;
  finishedAt?: string;
  createdAt?: string;
}

export interface JobDefinition {
  key: string;
  name: string;
  schedule: string;
  enabled: boolean;
  nextRunAt?: string;
}

interface HealthCheckResult {
  key: string;
  ok: boolean;
  level: "ok" | "warning" | "error";
  message: string;
}

export interface HealthStatus {
  results: HealthCheckResult[];
  overall: "ok" | "warning" | "error";
  checkedAt: string | null;
}

export interface ReleaseProfile {
  id: string;
  name: string;
  enabled: boolean;
  required: string[];
  ignored: string[];
  tags: string[];
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface AutoTagSpec {
  type: string;
  value: string | number | boolean;
  negate: boolean;
  required: boolean;
}

export interface AutoTag {
  id: string;
  name: string;
  removeTagsAutomatically: boolean;
  tags: string[];
  specifications: AutoTagSpec[];
  createdAt?: string | null;
  updatedAt?: string | null;
}

export type DiscoverMediaType = "movie" | "series";
export type DiscoverCategory = "trending" | "popular" | "upcoming" | "top_rated";

export interface DiscoverItem {
  tmdbId: number;
  mediaType: DiscoverMediaType;
  title: string;
  overview: string;
  releaseDate: string | null;
  year: number | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  rating: number | null;
  inLibrary: boolean;
  libraryId: string | null;
}

export interface DiscoverPage {
  page: number;
  totalPages: number;
  totalResults: number;
  results: DiscoverItem[];
}
