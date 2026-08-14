// SPDX-License-Identifier: MIT
/**
 * Roadmap P1, gap report B10 — provider status service integration.
 *
 * Exercises the real `ProviderStatusService` + wiring in `IndexersService` /
 * `AcquisitionService` against a real DB (createDb + migrations), the same
 * stub-the-provider pattern as rss-poll.spec.ts. Covers the full lifecycle the
 * gap report is scored against: a failing indexer is backed off (escalating),
 * eventually auto-disabled, then *skipped* instead of being hit on every poll —
 * and recovered via the explicit manual test()/healthcheck path. Plus the
 * download-client mirror through `AcquisitionService.syncAll()` and the healthy
 * provider success path (which clears failure state).
 *
 * Between iterations that must reach the next failure (escalation to
 * auto-disable), the test clears the provider_status.disabled_until row directly
 * to model "backoff expired, retried anyway" — the same way real time would let
 * the provider be attempted again after its window. Rate-limit windows are set
 * generously so they don't interfere with the backoff assertions.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { EventBus } from "@medianexus/events";
import { createDb, schema, type Db } from "@medianexus/database";
import type { Release } from "@medianexus/domain";
import type { HealthResult, DownloadClientContract, ClientQueueItem, AddDownloadInput } from "@medianexus/integrations";
import { IndexersService } from "../src/indexers/indexers.service";
import { EventsService } from "../src/events/events.service";
import { ProviderStatusService } from "../src/providers/provider-status.service";
import type { ProvidersService, ConfiguredClient } from "../src/providers/demo.providers";
import type { DecisionService } from "../src/decision/decision.service";
import { ConfigService } from "../src/system/config.service";
import { AcquisitionService } from "../src/acquisition/acquisition.service";
import { MediaRepository } from "../src/media/media.repository";
import { BlocklistService } from "../src/blocklist/blocklist.service";
import { RootFoldersService } from "../src/root-folders/root-folders.service";
import { RemotePathMappingsService } from "../src/remote-path-mappings/remote-path-mappings.service";
import { RecycleBinService } from "../src/media/recycle-bin.service";

const dir = mkdtempSync(join(tmpdir(), "mn-provstatus-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });

let counter = 0;
async function freshDb(): Promise<Db> {
  const handle = createDb(join(dir, `ps-${counter++}.db`));
  handle.runMigrations();
  handles.push(handle);
  return handle.db;
}

function makeConfig(db: Db) {
  return new ConfigService(db);
}

/** Tracking stub for an indexer provider — search can throw (failure path) or return. */
function indexerProvider(over: Partial<{ searchThrows: boolean; releases: Release[] }> = {}) {
  const calls = { search: 0, healthcheck: 0 };
  return {
    calls,
    provider: {
      kind: "usenet" as const,
      search: async () => {
        calls.search++;
        if (over.searchThrows) throw new Error("connection refused");
        return over.releases ?? [];
      },
      healthcheck: async (): Promise<HealthResult> => {
        calls.healthcheck++;
        return { ok: true, latencyMs: 5, message: null };
      },
    },
  };
}

async function seedIndexer(db: Db, over: Partial<typeof schema.indexer.$inferInsert> = {}): Promise<typeof schema.indexer.$inferSelect> {
  const now = new Date().toISOString();
  await db.insert(schema.indexer).values({
    id: "idx1", definitionKey: "newznab", name: "Demo", protocol: "usenet", enabled: true,
    implementation: "newznab", settings: {}, priority: 25, status: "ok", tags: [], createdAt: now, updatedAt: now,
    ...over,
  });
  return (await db.select().from(schema.indexer).where(eq(schema.indexer.id, "idx1")).limit(1))[0]!;
}

function buildIndexers(db: Db, provider: unknown, row: typeof schema.indexer.$inferSelect) {
  const config = makeConfig(db);
  const providers = { configuredIndexers: async () => [{ row, provider }] } as unknown as ProvidersService;
  const status = new ProviderStatusService(db, config);
  const indexers = new IndexersService(
    db, providers, new EventsService(new EventBus()), config, {} as unknown as DecisionService, status,
  );
  return { indexers, status, config, providers };
}

async function clearBackoff(db: Db, type: "indexer" | "downloadClient", id: string) {
  await db.update(schema.providerStatus)
    .set({ disabledUntil: null })
    .where(and(eq(schema.providerStatus.providerType, type), eq(schema.providerStatus.providerId, id)));
}

async function idxStatus(db: Db, id: string) {
  return (await db.select().from(schema.indexer).where(eq(schema.indexer.id, id)).limit(1))[0]!;
}

describe("ProviderStatusService + IndexersService.fetchReleases (B10)", () => {
  it("records a failure on a throwing indexer and then SKIPS it on the next poll (backoff)", async () => {
    const db = await freshDb();
    const row = await seedIndexer(db);
    const bp = indexerProvider({ searchThrows: true });
    const { indexers, status } = buildIndexers(db, bp.provider, row);

    const first = await indexers.pollRecent();
    expect(first).toEqual([]);
    expect(bp.calls.search).toBe(1);
    const st = await status.status("indexer", row.id);
    expect(st.consecutiveFailures).toBe(1);
    expect(st.disabledUntil).not.toBeNull();
    expect(st.autoDisabled).toBe(false);
    // indexer.status is flipped by ProviderStatusService (single writer).
    expect((await idxStatus(db, row.id)).status).toBe("error");

    // Second poll right away: backed off → the provider must NOT be hit.
    const second = await indexers.pollRecent();
    expect(second).toEqual([]);
    expect(bp.calls.search).toBe(1); // unchanged — dead indexer stopped being hit
  });

  it("escalates failures through the backoff tiers and auto-disables after the threshold", async () => {
    const db = await freshDb();
    const row = await seedIndexer(db);
    const bp = indexerProvider({ searchThrows: true });
    const { indexers, status } = buildIndexers(db, bp.provider, row);

    for (let i = 1; i <= 10; i++) {
      await indexers.pollRecent();
      // Model backoff expiry so the next poll actually attempts the provider again.
      await clearBackoff(db, "indexer", row.id);
      const st = await status.status("indexer", row.id);
      expect(st.consecutiveFailures).toBe(i);
      expect(st.autoDisabled).toBe(i >= 10); // threshold hit at 10
    }
    expect((await idxStatus(db, row.id)).status).toBe("error");
  });

  it("skips an auto-disabled indexer permanently until recovered", async () => {
    const db = await freshDb();
    const row = await seedIndexer(db);
    const bp = indexerProvider({ searchThrows: true });
    const { indexers, status } = buildIndexers(db, bp.provider, row);

    // Drive to auto-disable.
    for (let i = 0; i < 10; i++) {
      await indexers.pollRecent();
      await clearBackoff(db, "indexer", row.id);
    }
    const before = bp.calls.search;
    expect((await status.status("indexer", row.id)).autoDisabled).toBe(true);

    // Even with backoff long expired, the indexer stays skipped (auto-disabled).
    for (let i = 0; i < 3; i++) {
      await indexers.pollRecent();
    }
    expect(bp.calls.search).toBe(before); // provider never queried again
  });

  it("recovers an auto-disabled indexer via the explicit test() recovery path", async () => {
    const db = await freshDb();
    const row = await seedIndexer(db);
    const bp = indexerProvider({ searchThrows: true });
    const { indexers, status } = buildIndexers(db, bp.provider, row);

    for (let i = 0; i < 10; i++) {
      await indexers.pollRecent();
      await clearBackoff(db, "indexer", row.id);
    }
    expect((await status.status("indexer", row.id)).autoDisabled).toBe(true);

    // Manual test() with a now-healthy healthcheck must reach the provider and clear it.
    const res = await indexers.test(row.id);
    expect(res.ok).toBe(true);
    const st = await status.status("indexer", row.id);
    expect(st.autoDisabled).toBe(false);
    expect(st.consecutiveFailures).toBe(0);
    expect((await idxStatus(db, row.id)).status).toBe("ok");

    // And now the indexer is queryable again.
    const before = bp.calls.search;
    await indexers.pollRecent();
    expect(bp.calls.search).toBe(before + 1);
  });

  it("clears failure state on a healthy provider success path", async () => {
    const db = await freshDb();
    const row = await seedIndexer(db);
    const rel: Release = {
      id: "r1", indexerId: row.id, indexerName: row.name, title: "Interstellar.2014.1080p.WEB-DL",
      protocol: "torrent", categories: [], size: 1000, ageHours: 1, seeders: 10, leechers: 1,
      quality: { source: "web", resolution: "1080p", edition: "" }, isFreeleech: false, isProper: false, isRepack: false,
    };
    const bp = indexerProvider({ releases: [rel] });
    const { indexers, status } = buildIndexers(db, bp.provider, row);

    const out = await indexers.pollRecent();
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("r1");
    const st = await status.status("indexer", row.id);
    expect(st.consecutiveFailures).toBe(0);
    expect(st.lastSuccessAt).not.toBeNull();
    expect(st.autoDisabled).toBe(false);
    expect((await idxStatus(db, row.id)).status).toBe("ok");
  });
});

describe("ProviderStatusService + AcquisitionService.syncAll (B10 download clients)", () => {
  /** A download client whose getQueue() always throws and counts its own calls. */
  class ThrowingClient implements DownloadClientContract {
    readonly key = "throwing";
    readonly kind = "torrent" as const;
    calls = { getQueue: 0 };
    async getQueue(): Promise<ClientQueueItem[]> { this.calls.getQueue++; throw new Error("client unreachable"); }
    async addRelease(_i: AddDownloadInput): Promise<{ downloadId: string }> { throw new Error("n/a"); }
    async remove(): Promise<void> { /* noop */ }
    async healthcheck(): Promise<HealthResult> { return { ok: false, message: "unreachable" }; }
  }

  function buildSync(db: Db, config: ConfigService, providers: ProvidersService) {
    const events = new EventsService(new EventBus());
    const status = new ProviderStatusService(db, config);
    const blocklist = new BlocklistService(db);
    const mediaRoot = join(dir, `media-${counter}`);
    mkdirSync(mediaRoot, { recursive: true });
    const service = new AcquisitionService(
      db, config, events, providers, new MediaRepository(db), blocklist,
      new RootFoldersService(db), new RemotePathMappingsService(db), new RecycleBinService(config), status,
    );
    return { service, status };
  }

  it("backs off and auto-disables a failing download client, skipping its getQueue() polls", async () => {
    const db = await freshDb();
    const config = makeConfig(db);
    const client = new ThrowingClient();
    const providers = {
      configuredDownloadClients: async () => [{ row: { id: "dc1" }, provider: client }] as unknown as ConfiguredClient[],
    } as unknown as ProvidersService;
    const { service, status } = buildSync(db, config, providers);

    // Drive to auto-disable (simulating backoff expiry between attempts).
    for (let i = 1; i <= 10; i++) {
      await service.syncAll();
      await clearBackoff(db, "downloadClient", "dc1");
      const st = await status.status("downloadClient", "dc1");
      expect(st.consecutiveFailures).toBe(i);
      expect(st.autoDisabled).toBe(i >= 10);
    }
    expect(client.calls.getQueue).toBe(10);

    // Backed off / auto-disabled → syncAll skips the client entirely.
    const before = client.calls.getQueue;
    await service.syncAll();
    expect(client.calls.getQueue).toBe(before);

    // Recovery via ProviderStatusService.recordSuccess (the manual test() path clears it).
    await status.recordSuccess("downloadClient", "dc1");
    const st2 = await status.status("downloadClient", "dc1");
    expect(st2.autoDisabled).toBe(false);
    expect(st2.consecutiveFailures).toBe(0);
  });

  it("skips only the dead client in a mixed healthy/dead pool", async () => {
    const db = await freshDb();
    const config = makeConfig(db);
    const dead = new ThrowingClient();
    const healthyCalls = { getQueue: 0 };
    const healthy = {
      key: "healthy", kind: "torrent" as const,
      async getQueue(): Promise<ClientQueueItem[]> { healthyCalls.getQueue++; return []; },
      async addRelease(_i: AddDownloadInput): Promise<{ downloadId: string }> { return { downloadId: "h1" }; },
      async remove(): Promise<void> {},
      async healthcheck(): Promise<HealthResult> { return { ok: true }; },
    } satisfies DownloadClientContract;
    const providers = {
      configuredDownloadClients: async () => [
        { row: { id: "dead" }, provider: dead },
        { row: { id: "healthypt" }, provider: healthy },
      ] as unknown as ConfiguredClient[],
    } as unknown as ProvidersService;
    const { service } = buildSync(db, config, providers);

    // Auto-disable the dead client.
    for (let i = 0; i < 10; i++) {
      await service.syncAll();
      await clearBackoff(db, "downloadClient", "dead");
    }
    expect(dead.calls.getQueue).toBe(10);

    // Another syncAll: dead client skipped, healthy client still polled.
    await service.syncAll();
    expect(dead.calls.getQueue).toBe(10);
    expect(healthyCalls.getQueue).toBe(11);
  });
});
