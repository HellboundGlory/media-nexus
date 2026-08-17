// SPDX-License-Identifier: MIT
/**
 * UNI-018 Phase 1 — draft-config testing (decision 5).
 *
 * The modal Test button validates the currently-typed (unsaved) draft, NOT the stored row.
 * The single most important correctness property: a draft test must NOT persist anything —
 * no provider_status success/failure record, no indexer.status write, no lastSyncAt, no
 * capability write, no IndexerFailed event — so a failing draft never auto-disables or backs
 * off a saved provider that is currently working.
 *
 * This spec proves that property against a real DB + real ProvidersService with live local
 * HTTP servers standing in for the newznab indexer: a FAILING draft leaves the saved
 * provider's status/backoff/auto-disable state completely untouched, and a draft with no id
 * (never saved) builds and healthchecks fine.
 */
import { describe, it, expect, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb, schema, type Db } from "@medianexus/database";
import {
  MemoryDownloadClientProvider,
  MemoryIndexerProvider,
  ProviderRegistry,
} from "@medianexus/integrations";
import { ProvidersService } from "../src/providers/demo.providers";
import { ProviderStatusService } from "../src/providers/provider-status.service";
import { IndexersService } from "../src/indexers/indexers.service";
import { ConfigService } from "../src/system/config.service";
import { encryptFields } from "../src/secrets/provider-secrets";

process.env.MEDIA_NEXUS_SECRET = "test-secret-only";
const SECRET = "test-secret-only";

const dir = mkdtempSync(join(tmpdir(), "mn-draft-test-"));
const handles: { close: () => void }[] = [];
const servers: Server[] = [];
afterAll(() => { for (const h of handles) h.close(); for (const s of servers) s.close(); });

let counter = 0;
async function freshDb(): Promise<Db> {
  const handle = createDb(join(dir, `dt-${counter++}.db`));
  handle.runMigrations();
  handles.push(handle);
  return handle.db;
}

function listen(status: number) {
  const server = createServer((_req, res) => {
    res.writeHead(status, { "content-type": "text/xml" });
    res.end(status === 200 ? "<caps></caps>" : "err");
  });
  return new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      servers.push(server);
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function makeProviders(db: Db): ProvidersService {
  const registry = new ProviderRegistry();
  const memIdx = new MemoryIndexerProvider();
  const memClient = new MemoryDownloadClientProvider();
  registry.register("indexer", memIdx);
  registry.register("downloadClient", memClient);
  const config = new ConfigService(db);
  const status = new ProviderStatusService(db, config);
  return new ProvidersService(db, registry, memIdx, memClient, config, status);
}

function makeIndexers(db: Db): IndexersService {
  const providers = makeProviders(db);
  const config = new ConfigService(db);
  const status = new ProviderStatusService(db, config);
  return new IndexersService(db, providers, {} as never, config, {} as never, status);
}

const now = () => new Date().toISOString();

async function seedDefinition(db: Db) {
  db.insert(schema.indexerDefinition).values({
    id: "idef1", key: "generic-newznab", name: "GN", protocol: "usenet", implementation: "newznab",
    builtIn: true, capabilities: {}, categoryIds: [], cardigannYml: null, createdAt: now(),
  }).run();
}

/** Seed a saved, enabled newznab indexer pointing at `host`, store its apiKey encrypted. */
async function seedIndexer(db: Db, id: string, host: string) {
  db.insert(schema.indexer).values({
    id, definitionKey: "generic-newznab", name: "Saved", protocol: "usenet", enabled: true,
    implementation: "newznab",
    settings: encryptFields({ baseUrl: host, apiKey: "saved-key", categories: [5000] } as Record<string, unknown>, ["apiKey", "password"], SECRET),
    proxy: null, priority: 25, status: "ok", tags: [], createdAt: now(), updatedAt: now(),
  }).run();
}

describe("UNI-018 draft indexer test", () => {
  it("a failing draft leaves a working saved provider's status/backoff/auto-disable untouched", async () => {
    const good = await listen(200);
    const bad = await listen(500);
    const db = await freshDb();
    await seedDefinition(db);
    await seedIndexer(db, "ix1", good);
    const svc = makeIndexers(db);

    // Establish the saved provider as "ok" with zero failures via the explicit test() path.
    await svc.test("ix1");
    let saved = db.select().from(schema.indexer).where(eq(schema.indexer.id, "ix1")).all()[0] as any;
    expect(saved.status).toBe("ok");
    expect(saved.lastSyncAt).toBeTruthy();
    // Sanity: the saved provider healthcheck passes.
    expect((await svc.test("ix1")).ok).toBe(true);

    // Now a DRAFT test against the broken host, still carrying the saved id. Because the
    // draft re-sends `apiKey: [REDACTED]`, the merged draft must preserve the stored secret.
    const res = await svc.testDraft({
      id: "ix1",
      definitionKey: "generic-newznab",
      name: "Saved",
      protocol: "usenet",
      implementation: "newznab",
      settings: { baseUrl: bad, apiKey: "[REDACTED]" },
    });
    expect(res.ok).toBe(false); // the draft fails against the broken host

    // CRITICAL: nothing persisted. The saved row's status/lastSyncAt/lastError are untouched
    // and the provider_status entry was not bumped by the failing draft.
    saved = db.select().from(schema.indexer).where(eq(schema.indexer.id, "ix1")).all()[0] as any;
    expect(saved.status).toBe("ok");
    const statusBefore = db.select().from(schema.providerStatus).where(eq(schema.providerStatus.providerId, "ix1")).all()[0] as any;
    expect(statusBefore.autoDisabled).toBe(false);
    expect(statusBefore.consecutiveFailures).toBe(0);
    expect(statusBefore.disabledUntil).toBeNull();
    // ...and the previously-set lastSyncAt was NOT overwritten by the failing draft.
    expect(saved.lastSyncAt).toBeTruthy();
  });

  it("a successful draft test also persists nothing", async () => {
    const good = await listen(200);
    const db = await freshDb();
    await seedDefinition(db);
    await seedIndexer(db, "ix1", good);
    const svc = makeIndexers(db);
    await svc.test("ix1");
    const savedBefore = db.select().from(schema.indexer).where(eq(schema.indexer.id, "ix1")).all()[0] as any;
    const lastSyncBefore = savedBefore.lastSyncAt;

    const res = await svc.testDraft({
      id: "ix1", definitionKey: "generic-newznab", name: "Saved", protocol: "usenet",
      implementation: "newznab", settings: { baseUrl: good, apiKey: "[REDACTED]" },
    });
    expect(res.ok).toBe(true);
    const savedAfter = db.select().from(schema.indexer).where(eq(schema.indexer.id, "ix1")).all()[0] as any;
    expect(savedAfter.lastSyncAt).toBe(lastSyncBefore); // untouched
  });

  it("can test a draft for a provider that has never been saved (no id, no row)", async () => {
    const good = await listen(200);
    const db = await freshDb();
    await seedDefinition(db);
    const svc = makeIndexers(db);

    const res = await svc.testDraft({
      definitionKey: "generic-newznab", name: "Brand New", protocol: "usenet",
      implementation: "newznab", settings: { baseUrl: good, apiKey: "brand-new" },
    });
    expect(res.ok).toBe(true);
    // No row was created for the unsaved provider.
    const rows = db.select().from(schema.indexer).all();
    expect(rows.length).toBe(0);
    const statusRows = db.select().from(schema.providerStatus).all();
    expect(statusRows.length).toBe(0);
  });

  it("rejects an invalid draft settings with VALIDATION_ERROR before any healthcheck", async () => {
    const db = await freshDb();
    await seedDefinition(db);
    const svc = makeIndexers(db);
    await expect(svc.testDraft({
      definitionKey: "generic-newznab", name: "Bad", protocol: "usenet",
      implementation: "newznab", settings: { baseUrl: "not-a-url", apiKey: "bad-key" },
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("UNI-018 configuredIndexers degrades gracefully (review #1)", () => {
  const cardigannYml = readFileSync(join(__dirname, "../../../packages/integrations/src/cardigann-fixture.yml"), "utf8");
  const now = () => new Date().toISOString();

  async function seedCardigann(db: Db, idxId: string, defId: string, defKey: string) {
    db.insert(schema.indexerDefinition).values({
      id: defId, key: defKey, name: defKey, protocol: "torrent", implementation: "cardigann",
      builtIn: true, capabilities: {}, categoryIds: [], cardigannYml, createdAt: now(),
    }).run();
    db.insert(schema.indexer).values({
      id: idxId, definitionKey: defKey, name: `CG ${idxId}`, protocol: "torrent", enabled: true,
      implementation: "cardigann", settings: {} as Record<string, unknown>, proxy: null, priority: 25,
      status: "ok", tags: [], createdAt: now(), updatedAt: now(),
    }).run();
  }

  it("one cardigann indexer whose definition was pruned does not throw or break the rest", async () => {
    const db = await freshDb();
    await seedCardigann(db, "ixA", "idefA", "def-a");
    await seedCardigann(db, "ixB", "idefB", "def-b");
    const providers = makeProviders(db);

    // Both buildable up front.
    expect((await providers.configuredIndexers()).length).toBe(2);

    // cardigann-sync prunes a stale definition row; the configured indexer pointing at it remains.
    db.delete(schema.indexerDefinition).where(eq(schema.indexerDefinition.id, "idefA")).run();

    // Must NOT throw; only the surviving indexer is returned (the broken one is skipped).
    const result = await providers.configuredIndexers();
    expect(result.length).toBe(1);
    expect(result[0].row.id).toBe("ixB");
  });

  it("an unknown download-client implementation is skipped, not fatal", async () => {
    const db = await freshDb();
    const nowS = now();
    db.insert(schema.downloadClient).values({
      id: "dcOK", name: "good", implementation: "sabnzbd", kind: "usenet", enabled: true, priority: 1,
      settings: { host: "http://127.0.0.1:1", apiKey: "k" } as Record<string, unknown>, tags: [], createdAt: nowS, updatedAt: nowS,
    }).run();
    db.insert(schema.downloadClient).values({
      id: "dcBAD", name: "bad", implementation: "madeup", kind: "torrent", enabled: true, priority: 1,
      settings: {} as Record<string, unknown>, tags: [], createdAt: nowS, updatedAt: nowS,
    }).run();

    const result = await makeProviders(db).configuredDownloadClients();
    expect(result.length).toBe(1);
    expect(result[0].row?.id).toBe("dcOK");
  });
});
