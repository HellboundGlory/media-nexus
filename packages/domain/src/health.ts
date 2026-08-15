// SPDX-License-Identifier: MIT

/**
 * Health check registry (roadmap P1, gap report B9).
 *
 * Before this, "health" meant a liveness ping and a `SELECT 1` (see
 * `apps/api/src/health/health.controller.ts`) — nothing told a user their indexer had
 * been failing for three days, their download client was unreachable, or their root
 * folder had gone missing.
 *
 * Same split as the decision engine (`decision.ts`): pure checks over a `HealthContext`
 * snapshot assembled once by the API layer (`apps/api/src/health/health-check.service.ts`)
 * — this file stays pure domain code with no DB/network access. No check here branches on
 * media type; there's nothing media-specific about system health.
 *
 * The 10 checks match the gap report's own suggested starting list, with one honest
 * rename: its "unmapped remote path" item is really "a completed download's content
 * couldn't be found anywhere on disk" — see `HealthContext.contentNotFoundCount`'s doc
 * comment for why a more specific diagnosis isn't reliably possible from the data
 * available.
 */

export type HealthLevel = "ok" | "warning" | "error";

export interface HealthCheckResult {
  key: string;
  ok: boolean;
  level: HealthLevel;
  message: string;
}

/** Everything a check needs, assembled once per run by the API layer. */
export interface HealthContext {
  indexers: { enabled: boolean; status: string; autoDisabled: boolean }[];
  downloadClients: { enabled: boolean; kind: "usenet" | "torrent"; reachable: boolean; autoDisabled: boolean }[];
  rootFolders: { name: string; accessible: boolean; freeBytes: number | null }[];
  downloadsPathConfigured: boolean;
  downloadsPathAccessible: boolean;
  /** `media.minimumFreeSpaceMb` — reused as-is rather than adding a second threshold
   *  setting; it's already the number the decision engine treats as the safety margin. */
  minimumFreeSpaceMb: number;
  preferredProtocol: "usenet" | "torrent" | "any";
  /** job_run rows with status failed/timed_out whose finishedAt falls in the last hour. */
  recentFailedJobKeys: string[];
  /** download_queue_entry rows in the last 24h whose status is `failed` and whose
   *  errorMessage is exactly the "no video file found ... under <downloadsRoot>" string
   *  `AcquisitionService.importCompletedEntry()` throws when `resolveContent()` finds
   *  nothing at all (not the similarly-worded "found a directory, but nothing playable
   *  inside it" case a few lines later, which the API-layer assembly step is responsible
   *  for excluding — this is a generic "content missing" signal, not a way to distinguish
   *  a bad `paths.downloads`, a missing remote path mapping, or a moved/deleted file). */
  recentContentNotFoundCount: number;
}

type HealthCheck = (ctx: HealthContext) => HealthCheckResult;

const ok = (key: string, message: string): HealthCheckResult => ({ key, ok: true, level: "ok", message });
const warn = (key: string, message: string): HealthCheckResult => ({ key, ok: false, level: "warning", message });
const err = (key: string, message: string): HealthCheckResult => ({ key, ok: false, level: "error", message });

const indexersNone: HealthCheck = (ctx) => {
  const enabled = ctx.indexers.filter((i) => i.enabled);
  if (enabled.length === 0) return err("indexers.none", "No indexers are enabled — searches and RSS sync will find nothing.");
  return ok("indexers.none", `${enabled.length} indexer(s) enabled.`);
};

const indexersAllFailing: HealthCheck = (ctx) => {
  const enabled = ctx.indexers.filter((i) => i.enabled);
  if (enabled.length === 0) return ok("indexers.allFailing", "No enabled indexers to check.");
  const failing = enabled.filter((i) => i.status === "error");
  if (failing.length === enabled.length) {
    return err("indexers.allFailing", `All ${enabled.length} enabled indexer(s) are failing health checks.`);
  }
  if (failing.length > 0) {
    return warn("indexers.allFailing", `${failing.length} of ${enabled.length} enabled indexer(s) are failing health checks.`);
  }
  return ok("indexers.allFailing", "All enabled indexers are healthy.");
};

const downloadClientsUnreachable: HealthCheck = (ctx) => {
  const enabled = ctx.downloadClients.filter((c) => c.enabled);
  if (enabled.length === 0) return warn("downloadClients.unreachable", "No download clients configured — grabbed releases can't be sent anywhere.");
  const unreachable = enabled.filter((c) => !c.reachable);
  if (unreachable.length === enabled.length) {
    return err("downloadClients.unreachable", `All ${enabled.length} configured download client(s) are unreachable.`);
  }
  if (unreachable.length > 0) {
    return warn("downloadClients.unreachable", `${unreachable.length} of ${enabled.length} download client(s) are unreachable.`);
  }
  return ok("downloadClients.unreachable", "All download clients are reachable.");
};

// Roadmap P1, gap report B10: a provider that hit the auto-disable threshold (repeated
// consecutive failures) is skipped by the wired call sites until an explicit recovery path
// (manual test()/healthcheck) clears it. This surfaces that a provider is soft-disabled —
// distinct from `indexers.allFailing`/`downloadClients.unreachable`, which read live
// healthcheck state, not the accumulated backoff state.
const indexersAutoDisabled: HealthCheck = (ctx) => {
  const enabled = ctx.indexers.filter((i) => i.enabled);
  if (enabled.length === 0) return ok("indexers.autoDisabled", "No enabled indexers to check.");
  const disabled = enabled.filter((i) => i.autoDisabled);
  if (disabled.length === enabled.length) {
    return err("indexers.autoDisabled", `All ${enabled.length} enabled indexer(s) are auto-disabled after repeated failures — run a manual indexer health check to re-enable.`);
  }
  if (disabled.length > 0) {
    return warn("indexers.autoDisabled", `${disabled.length} of ${enabled.length} enabled indexer(s) are auto-disabled after repeated failures.`);
  }
  return ok("indexers.autoDisabled", "No enabled indexers are auto-disabled.");
};

const downloadClientsAutoDisabled: HealthCheck = (ctx) => {
  const enabled = ctx.downloadClients.filter((c) => c.enabled);
  if (enabled.length === 0) return ok("downloadClients.autoDisabled", "No download clients to check.");
  const disabled = enabled.filter((c) => c.autoDisabled);
  if (disabled.length === enabled.length) {
    return err("downloadClients.autoDisabled", `All ${enabled.length} configured download client(s) are auto-disabled after repeated failures — run a manual client health check to re-enable.`);
  }
  if (disabled.length > 0) {
    return warn("downloadClients.autoDisabled", `${disabled.length} of ${enabled.length} download client(s) are auto-disabled after repeated failures.`);
  }
  return ok("downloadClients.autoDisabled", "No download clients are auto-disabled.");
};

const rootFoldersMissingOrUnwritable: HealthCheck = (ctx) => {
  if (ctx.rootFolders.length === 0) return warn("rootFolders.missingOrUnwritable", "No root folders configured.");
  const bad = ctx.rootFolders.filter((r) => !r.accessible);
  if (bad.length > 0) {
    return err("rootFolders.missingOrUnwritable", `${bad.length} root folder(s) missing or unwritable: ${bad.map((r) => r.name).join(", ")}.`);
  }
  return ok("rootFolders.missingOrUnwritable", `${ctx.rootFolders.length} root folder(s) accessible.`);
};

const downloadsPathMissing: HealthCheck = (ctx) => {
  if (!ctx.downloadsPathConfigured) return warn("downloadsPath.missing", "paths.downloads is not configured.");
  if (!ctx.downloadsPathAccessible) return err("downloadsPath.missing", "The configured downloads path does not exist or is not accessible.");
  return ok("downloadsPath.missing", "Downloads path is accessible.");
};

const diskSpaceLow: HealthCheck = (ctx) => {
  const low = ctx.rootFolders.filter((r) => r.freeBytes !== null && r.freeBytes < ctx.minimumFreeSpaceMb * 1024 * 1024);
  if (low.length > 0) {
    return warn("diskSpace.low", `Low disk space on ${low.length} root folder(s): ${low.map((r) => r.name).join(", ")} (below the configured ${ctx.minimumFreeSpaceMb}MB margin).`);
  }
  return ok("diskSpace.low", "Free space is above the configured margin on every root folder.");
};

const protocolNoClientForPreferred: HealthCheck = (ctx) => {
  if (ctx.preferredProtocol === "any") return ok("protocol.noClientForPreferred", "No specific protocol preference configured.");
  const hasClient = ctx.downloadClients.some((c) => c.enabled && c.kind === ctx.preferredProtocol);
  if (!hasClient) {
    return err("protocol.noClientForPreferred", `media.preferredProtocol is "${ctx.preferredProtocol}" but no enabled download client of that kind exists.`);
  }
  return ok("protocol.noClientForPreferred", `An enabled ${ctx.preferredProtocol} download client is configured.`);
};

const jobsRecentFailures: HealthCheck = (ctx) => {
  if (ctx.recentFailedJobKeys.length === 0) return ok("jobs.recentFailures", "No job failures in the last hour.");
  return warn("jobs.recentFailures", `${ctx.recentFailedJobKeys.length} job run(s) failed or timed out in the last hour: ${[...new Set(ctx.recentFailedJobKeys)].join(", ")}.`);
};

const acquisitionContentNotFound: HealthCheck = (ctx) => {
  if (ctx.recentContentNotFoundCount === 0) return ok("acquisition.contentNotFound", "No recent import content-not-found failures.");
  return warn(
    "acquisition.contentNotFound",
    `${ctx.recentContentNotFoundCount} completed download(s) in the last 24h had no content found on disk — check paths.downloads, root folder paths, or remote path mappings.`,
  );
};

/** Order is presentation order only — every check runs regardless. */
export const HEALTH_CHECKS: readonly HealthCheck[] = [
  indexersNone,
  indexersAllFailing,
  indexersAutoDisabled,
  downloadClientsUnreachable,
  downloadClientsAutoDisabled,
  rootFoldersMissingOrUnwritable,
  downloadsPathMissing,
  diskSpaceLow,
  protocolNoClientForPreferred,
  jobsRecentFailures,
  acquisitionContentNotFound,
];

export function runHealthChecks(ctx: HealthContext): HealthCheckResult[] {
  return HEALTH_CHECKS.map((check) => check(ctx));
}

const LEVEL_RANK: Record<HealthLevel, number> = { ok: 0, warning: 1, error: 2 };

/** Worst level across a result set — what a UI banner or `/system/health`'s summary
 *  field should show. */
export function overallLevel(results: HealthCheckResult[]): HealthLevel {
  return results.reduce<HealthLevel>((worst, r) => (LEVEL_RANK[r.level] > LEVEL_RANK[worst] ? r.level : worst), "ok");
}
