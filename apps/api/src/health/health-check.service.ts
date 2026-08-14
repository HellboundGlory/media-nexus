// SPDX-License-Identifier: MIT
import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray } from "drizzle-orm";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { schema, type Db } from "@medianexus/database";
import { EventTypes } from "@medianexus/events";
import { runHealthChecks, overallLevel, type HealthContext, type HealthCheckResult, type HealthLevel } from "@medianexus/domain";
import { DB_TOKEN } from "../db/database.module";
import { ConfigService } from "../system/config.service";
import { RootFoldersService } from "../root-folders/root-folders.service";
import { ProvidersService } from "../providers/demo.providers";
import { EventsService } from "../events/events.service";

/** The exact prefix `AcquisitionService.importCompletedEntry()` throws when
 *  `resolveContent()` finds nothing at all (acquisition.service.ts, "no video file found
 *  anywhere" case) — distinct from two structurally similar messages thrown later in the
 *  same file when content *was* found but had no video inside it. Matched by prefix here
 *  and then narrowed by the known `downloadsRoot` suffix below, since only the
 *  content-not-found-anywhere case uses that suffix. */
const CONTENT_NOT_FOUND_PREFIX = 'No video file found for "';

/**
 * Assembles `HealthContext` (DB/IO) and runs the pure registry from
 * `packages/domain/src/health.ts` — same split as `DecisionService`/`decision.ts`.
 * Invoked by the `system.healthCheck` job handler and by `GET /api/v1/system/health`
 * (which reads the persisted result of the last run rather than re-running live).
 */
@Injectable()
export class HealthCheckService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly config: ConfigService,
    private readonly rootFolders: RootFoldersService,
    private readonly providers: ProvidersService,
    private readonly events: EventsService,
  ) {}

  async run(): Promise<{ results: HealthCheckResult[]; overall: HealthLevel }> {
    const ctx = await this.buildContext();
    const results = runHealthChecks(ctx);
    const overall = overallLevel(results);
    await this.persist(results);
    this.events.publish(EventTypes.HealthCheckCompleted, { results, overall });
    return { results, overall };
  }

  /** Persisted results of the last run — does not re-probe anything live. */
  async latest(): Promise<{ results: HealthCheckResult[]; overall: HealthLevel; checkedAt: string | null }> {
    const rows = await this.db.select().from(schema.healthCheckResult);
    const results: HealthCheckResult[] = rows.map((r) => ({ key: r.key, ok: r.ok, level: r.level as HealthLevel, message: r.message }));
    const checkedAt = rows.reduce<string | null>((latest, r) => (!latest || r.checkedAt > latest ? r.checkedAt : latest), null);
    return { results, overall: overallLevel(results), checkedAt };
  }

  private async persist(results: HealthCheckResult[]): Promise<void> {
    const now = new Date().toISOString();
    this.db.transaction((tx) => {
      for (const r of results) {
        tx.insert(schema.healthCheckResult)
          .values({ id: `health_${r.key}`, key: r.key, ok: r.ok, level: r.level, message: r.message, checkedAt: now })
          .onConflictDoUpdate({ target: schema.healthCheckResult.key, set: { ok: r.ok, level: r.level, message: r.message, checkedAt: now } })
          .run();
      }
    });
  }

  private async buildContext(): Promise<HealthContext> {
    const cfg = await this.config.get();

    const indexers = await this.db.select({ enabled: schema.indexer.enabled, status: schema.indexer.status }).from(schema.indexer);

    const configuredClients = await this.providers.configuredDownloadClients();
    const downloadClients = await Promise.all(
      configuredClients.map(async (c) => {
        const reachable = await c.provider.healthcheck().then((r) => r.ok).catch(() => false);
        return { enabled: true, kind: c.provider.kind, reachable };
      }),
    );

    const rootFolderRows = await this.rootFolders.list();
    const rootFolders = rootFolderRows.map((r) => ({ name: r.name, accessible: r.accessible, freeBytes: r.freeBytes }));

    const downloadsPathConfigured = !!cfg["paths.downloads"];
    const downloadsPathAccessible = downloadsPathConfigured
      && existsSync(cfg["paths.downloads"])
      && statSync(cfg["paths.downloads"]).isDirectory();

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const failedJobs = await this.db.select({ jobKey: schema.jobRun.jobKey }).from(schema.jobRun)
      .where(and(inArray(schema.jobRun.status, ["failed", "timed_out"]), gte(schema.jobRun.finishedAt, oneHourAgo)));

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    // Same fallback AcquisitionService.importCompletedEntry() uses when paths.downloads is
    // unset — needed to reconstruct the exact string it threw.
    const downloadsRoot = cfg["paths.downloads"] || resolve(process.cwd(), "data", "downloads");
    const recentFailed = await this.db.select({ errorMessage: schema.downloadQueueEntry.errorMessage })
      .from(schema.downloadQueueEntry)
      .where(and(eq(schema.downloadQueueEntry.status, "failed"), gte(schema.downloadQueueEntry.updatedAt, oneDayAgo)));
    const expectedSuffix = ` under ${downloadsRoot}`;
    const recentContentNotFoundCount = recentFailed.filter(
      (r) => r.errorMessage?.startsWith(CONTENT_NOT_FOUND_PREFIX) && r.errorMessage.endsWith(expectedSuffix),
    ).length;

    return {
      indexers,
      downloadClients,
      rootFolders,
      downloadsPathConfigured,
      downloadsPathAccessible,
      minimumFreeSpaceMb: cfg["media.minimumFreeSpaceMb"],
      preferredProtocol: cfg["media.preferredProtocol"],
      tmdbApiKeyConfigured: !!cfg["metadata.tmdbApiKey"],
      recentFailedJobKeys: failedJobs.map((j) => j.jobKey),
      recentContentNotFoundCount,
    };
  }
}
