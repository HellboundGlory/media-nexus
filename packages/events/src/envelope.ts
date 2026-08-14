// SPDX-License-Identifier: MIT
import { ensureCorrelationId, newUuid } from "@medianexus/shared";

/** Aggregate pointer embedded in every event for traceability. */
export interface EventAggregate {
  /** mediaType-like kind of the affected aggregate. */
  aggType?: string;
  aggId?: string;
  jobRunId?: string;
}

/** The durable, versioned envelope MediaNexus uses for all domain events. */
export interface DomainEvent<T = Record<string, unknown>> {
  id: string;
  type: string;
  version: number;
  occurredAt: string;
  correlationId: string;
  aggregate: EventAggregate;
  payload: T;
}

/** Convenience factory honoring the ambient correlation id when present. */
export function domainEvent<T>(
  type: string,
  payload: T,
  aggregate: EventAggregate = {},
  version = 1,
): DomainEvent<T> {
  return {
    id: newUuid(),
    type,
    version,
    occurredAt: new Date().toISOString(),
    correlationId: ensureCorrelationId(),
    aggregate,
    payload,
  };
}

/** Every known event type, as a single source of names (avoids typos). */
export const EventTypes = {
  MovieAdded: "media.movie.added",
  SeriesAdded: "media.series.added",
  MovieRemoved: "media.movie.removed",
  SeriesRemoved: "media.series.removed",
  ReleaseGrabbed: "acquisition.release.grabbed",
  DownloadStarted: "acquisition.download.started",
  DownloadCompleted: "acquisition.download.completed",
  ImportCompleted: "acquisition.import.completed",
  ImportFailed: "acquisition.import.failed",
  DownloadFailed: "acquisition.download.failed",
  IndexerFailed: "discovery.indexer.failed",
  DownloadClientFailed: "acquisition.client.failed",
  JobStarted: "system.job.started",
  JobSucceeded: "system.job.succeeded",
  JobFailed: "system.job.failed",
  HealthCheckCompleted: "system.health.completed",
} as const;

export const KNOWN_EVENT_TYPES = Object.values(EventTypes);
