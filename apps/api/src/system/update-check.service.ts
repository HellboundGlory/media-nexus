// SPDX-License-Identifier: MIT
import { Injectable, Logger } from "@nestjs/common";
import { SystemStatusService } from "./system-status.service";

const GITHUB_TAGS_URL =
  "https://api.github.com/repos/HellboundGlory/media-nexus/tags";
// GitHub renders a real page for any pushed tag (diff/commits since the previous tag, source
// downloads) even without a GitHub Release object — point the badge there, not the bare index.
const RELEASES_TAG_PAGE = "https://github.com/HellboundGlory/media-nexus/releases/tag";
// GitHub's unauthenticated rate limit is 60 req/hr/IP; a once-daily check is nowhere near it.
const FETCH_TIMEOUT_MS = 15_000; // matches the AbortSignal.timeout used by tmdb.ts/tvdb.ts
// Release-version tags in this project are pushed as plain `vX.Y.Z`; ignore any other tag
// (design/draft/anime tags etc.) rather than miscompare against it.
const VERSION_TAG = /^\d+\.\d+\.\d+$/;

/** A completed update check (cache is warm). latestVersion/releaseUrl are null when the repo has
 * no release-version tags yet ("nothing to report") — that is a successful state, not an error. */
interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  checkedAt: string;
}

/** The endpoint's "not checked yet" shape — used until the first successful run() completes. */
interface UpdateCheckNotChecked {
  checked: false;
  currentVersion: string;
  latestVersion: null;
  updateAvailable: false;
  releaseUrl: null;
  checkedAt: null;
}

export type UpdateCheckState = UpdateCheckResult | UpdateCheckNotChecked;

/**
 * Compare two x.y.z version strings numerically per dot-segment. Returns <0 when `a < b`,
 * >0 when `a > b`, 0 when equal. A leading `v` is stripped; missing or non-numeric segments
 * are treated as 0, so a release tag ("v1.2.0") and a plain version ("1.2.0") compare equal,
 * and a dev build ahead of the last tag (e.g. current 1.2.1 vs latest 1.2.0) yields >0 without
 * crashing. MediaNexus ships plain numeric x.y.z tags — a full semver prerelease parser is not
 * needed, so no new dependency is pulled in for this.
 */
export function compareVersions(a: string, b: string): number {
  const pa = String(a).replace(/^v/i, "").split(".");
  const pb = String(b).replace(/^v/i, "").split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = Number.parseInt(pa[i] ?? "0", 10) || 0;
    const nb = Number.parseInt(pb[i] ?? "0", 10) || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

/**
 * Roadmap P3, gap report C8 (update-check sub-item): periodically ask "is a newer MediaNexus
 * release available", cache the answer in memory, and surface it — it NEVER touches the running
 * binary/container.
 *
 * A real self-updater makes no sense for this app: MediaNexus is Docker/GHCR-only (see
 * docker/Dockerfile — there is no native/binary install path), so the actual update action for
 * an operator is `docker pull` + restart (or their compose/watchtower setup), and the app has
 * nothing to replace itself with. Building an in-app updater would be actively wrong for the
 * deployment model. This is a read-only CHECK — a correctness decision, not a scope cut; if a
 * future session is tempted to "helpfully" add self-update, re-read this comment first.
 *
 * The source of truth for "what version was released" is this repo's git TAGS, not GitHub
 * Releases: this project's release process is "push a `vX.Y.Z` tag, CI publishes a GHCR image"
 * and no GitHub Release object is ever created, so `/releases/latest` stays 404-forever. We
 * therefore read the tags list endpoint and pick the max `vX.Y.Z` tag ourselves. A repo with no
 * release-version tags yet is an expected, successful "nothing to report" outcome (not an error).
 *
 * Network failures are expected and tolerated: this is a LAN app, and many real installs have no
 * internet egress at all (or GitHub is transiently down / rate-limited). On any failure the job
 * logs at WARN (never ERROR — no internet is a permanent, unremarkable state, not something the
 * Logs page should flag as alarming) and leaves the last known result stale rather than throwing.
 * The cache is deliberately in-memory only (a restart clears it — the next scheduled tick simply
 * refreshes it); it is ephemeral operational state, not configuration, so no DB table or
 * settings-blob key is warranted.
 */
@Injectable()
export class UpdateCheckService {
  private readonly logger = new Logger(UpdateCheckService.name);
  private result: UpdateCheckResult | null = null;
  /** Swappable in tests; mirrors the `fetchImpl` pattern in packages/integrations providers. */
  fetchImpl: typeof fetch = fetch;

  constructor(private readonly statusSvc: SystemStatusService) {}

  /** The cached result (or a "not checked yet" shape). Never performs a network call. */
  get(): UpdateCheckState {
    if (!this.result) {
      return {
        checked: false,
        currentVersion: this.statusSvc.version,
        latestVersion: null,
        updateAvailable: false,
        releaseUrl: null,
        checkedAt: null,
      };
    }
    return { checked: true, ...this.result } as UpdateCheckState;
  }

  /**
   * Runs one update check (invoked by the `system.updateCheck` job on a daily schedule, and by
   * the generic POST /system/commands/:jobKey trigger). Tolerant of every real-world shape:
   *
   *  - Network error / non-200 / non-array body => warn + keep the last known result stale
   *    (never throws, so an internet-less LAN install never has this job fail loudly).
   *  - Valid array with ZERO `vX.Y.Z` tags => a legitimate, successful "nothing to report yet"
   *    (e.g. a fresh repo / tags cleaned up). Recorded as a warm no-latest state, NOT a warn —
   *    that is an expected, unremarkable condition, not a failure.
   *  - Valid array with one or more `vX.Y.Z` tags => max by `compareVersions`, set updateAvailable.
   */
  async run(): Promise<UpdateCheckResult | null> {
    try {
      const res = await this.fetchImpl(GITHUB_TAGS_URL, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "MediaNexus",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`GitHub tags responded ${res.status}`);
      const body = (await res.json()) as unknown;
      // The GitHub tags endpoint returns an array of { name, commit, ... }. Be defensive: a
      // non-array (or a body that isn't what we expect) is treated as a failure below.
      if (!Array.isArray(body)) throw new Error("GitHub tags responded with a non-array body");
      const versions = (body as { name?: unknown }[])
        .map((t) => (typeof t?.name === "string" ? t.name : ""))
        .map((n) => n.replace(/^v/i, ""))
        .filter((n) => VERSION_TAG.test(n));

      // Tags need not be in order; pick the max version ourselves via compareVersions. When no
      // release-version tags exist yet, `latest` stays null = "nothing to report" (not an error).
      const current = this.statusSvc.version;
      const latest = versions.length
        ? versions.reduce((a, b) => (compareVersions(a, b) > 0 ? a : b))
        : null;
      this.result = {
        currentVersion: current,
        latestVersion: latest,
        updateAvailable: latest ? compareVersions(current, latest) < 0 : false,
        releaseUrl: latest ? `${RELEASES_TAG_PAGE}/v${latest}` : null,
        checkedAt: new Date().toISOString(),
      };
      this.logger.log(
        latest
          ? `update check: current ${current}, latest ${latest}${compareVersions(current, latest) < 0 ? " (update available)" : ""}`
          : `update check: current ${current}, no release-version tags found yet`,
      );
      return this.result;
    } catch (err) {
      // Deliberately a warn, not an error — see the class-level comment on why.
      this.logger.warn(`update check failed, keeping last known result: ${(err as Error).message}`);
      return this.result;
    }
  }
}
