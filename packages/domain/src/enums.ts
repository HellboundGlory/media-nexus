// SPDX-License-Identifier: MIT
import { z } from "zod";

export const monitoredStatusSchema = z.enum(["monitored", "unmonitored"]);

// --- Media lifecycle ---
export const movieStatusSchema = z.enum([
  "released", "in_cinemas", "post_processing", "announced", "upcoming",
  "tba", "unknown",
]);
export const seriesStatusSchema = z.enum([
  "continuing", "ended", "upcoming", "unknown",
]);
export const seriesTypeSchema = z.enum(["standard", "daily", "anime"]);

export const availabilityStateSchema = z.enum([
  "unknown", "processing", "partially_available", "available",
]);

// --- Indexers ---
export const indexerProtocolSchema = z.enum(["usenet", "torrent"]);
export const indexerStatusSchema = z.enum(["ok", "error", "disabled"]);

// --- Download clients ---
export const downloadClientKindSchema = z.enum(["usenet", "torrent"]);

// --- Requests ---
export const requestStatusSchema = z.enum([
  "pending", "approved", "declined", "processing", "fulfilled", "failed", "expired",
]);
export const requestItemStatusSchema = z.enum([
  "pending", "approved", "declined", "processing", "fulfilled", "failed",
]);

// --- History ---
export const historyActionSchema = z.enum([
  "grabbed", "download_completed", "import_completed", "upgraded",
  "download_failed", "import_failed", "release_missing", "request_created",
  "request_approved", "request_declined", "removed",
]);

// --- Queue ---
export const queueStatusSchema = z.enum([
  "queued", "downloading", "paused", "completed", "failed", "importing", "imported", "removed",
  "stalled", "download_failed",
]);

/** Queue statuses that still represent an in-progress download for a title — used to guard
 *  re-search/re-grab of the same media until the entry resolves one way or another.
 *  `stalled` MUST be active: while an entry is stalled it hasn't failed yet, so treating it
 *  as inactive would let re-search fire before the failure-escalation path (which blocklists
 *  and genuinely clears the way) has had a chance to run. */
export const ACTIVE_QUEUE_STATUSES = ["queued", "downloading", "paused", "importing", "stalled"] as const;

// --- Jobs ---
export const jobStatusSchema = z.enum([
  "queued", "running", "succeeded", "failed", "retrying", "cancelled", "timed_out",
]);
export const jobTriggerSchema = z.enum(["scheduled", "manual", "event"]);

export type RequestStatus = z.infer<typeof requestStatusSchema>;
export type JobStatus = z.infer<typeof jobStatusSchema>;
export type MediaStatus = "released" | "continuing";
