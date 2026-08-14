// SPDX-License-Identifier: MIT
/**
 * Roadmap P2, gap report D3/J5 — download-client provider session reuse.
 *
 * The session-reuse bug: `ProvidersService.configuredDownloadClients()` constructed every
 * provider fresh on each call, so qBittorrent's SID cookie (an instance field) was discarded
 * every poll and a fresh login happened every cycle. This spec proves the fix against a real
 * DB and real ProvidersService with a live local `node:http` server standing in for
 * qBittorrent: two consecutive calls return the SAME provider instance, and a login happens
 * exactly once across reused calls (the cookie survives). Also proves invalidation: after
 * `invalidateDownloadClient()` the next call rebuilds a different instance.
 */
import { describe, it, expect, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, schema, type Db } from "@medianexus/database";
import {
  MemoryDownloadClientProvider,
  MemoryIndexerProvider,
  ProviderRegistry,
} from "@medianexus/integrations";
import { ProvidersService } from "../src/providers/demo.providers";
import { ProviderStatusService } from "../src/providers/provider-status.service";
import { ConfigService } from "../src/system/config.service";

const dir = mkdtempSync(join(tmpdir(), "mn-dlclients-d3-"));
const handles: { close: () => void }[] = [];
const servers: Server[] = [];
afterAll(() => { for (const h of handles) h.close(); for (const s of servers) s.close(); });

let counter = 0;
async function freshDb(): Promise<Db> {
  const handle = createDb(join(dir, `dc-${counter++}.db`));
  handle.runMigrations();
  handles.push(handle);
  return handle.db;
}

function listen(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, url: URL) => void) {
  const server = createServer((req, res) => handler(req, res, new URL(req.url ?? "/", "http://127.0.0.1")));
  return new Promise<{ url: string; server: Server }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, server });
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

async function seedQbt(db: Db, host: string): Promise<string> {
  const now = new Date().toISOString();
  const id = "dc1";
  await db.insert(schema.downloadClient).values({
    id,
    name: "qbit-qbt",
    implementation: "qbittorrent",
    kind: "torrent",
    enabled: true,
    priority: 1,
    settings: { host, username: "admin", password: "pw", category: "movies", tag: "mn" } as Record<string, unknown>,
    tags: [],
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

const qbtServer = () =>
  listen((req, res, u) => {
    if (u.pathname === "/api/v2/auth/login") {
      res.writeHead(200, { "set-cookie": ["SID=reused-abc"] });
      res.end("Ok.");
      return;
    }
    if (u.pathname === "/api/v2/torrents/info") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
      return;
    }
    if (u.pathname === "/api/v2/app/version") { res.writeHead(200); res.end("v4.6.0"); return; }
    res.writeHead(404); res.end();
  });

describe("D3 download-client session reuse", () => {
  it("returns the same provider instance and logs in exactly once across reused calls", async () => {
    let logins = 0;
    const { url, server } = await listen((req, res, u) => {
      if (u.pathname === "/api/v2/auth/login") { logins++; res.writeHead(200, { "set-cookie": ["SID=reused-abc"] }); res.end("Ok."); return; }
      if (u.pathname === "/api/v2/torrents/info") { res.writeHead(200, { "content-type": "application/json" }); res.end("[]"); return; }
      res.writeHead(404); res.end();
    });
    servers.push(server);

    const db = await freshDb();
    await seedQbt(db, url);
    const providers = makeProviders(db);

    const first = await providers.configuredDownloadClients();
    const second = await providers.configuredDownloadClients();
    // Session-reuse fix: two calls return the SAME provider instance (cached), so its SID
    // cookie survives instead of re-logging in. Pre-fix this was two distinct instances.
    expect(first[0].provider).toBe(second[0].provider);

    // Force a login, then reuse the shared instance — login must happen exactly once.
    await first[0].provider.getQueue();
    await second[0].provider.getQueue();
    expect(logins).toBe(1);
  });

  it("rebuilds a fresh provider after invalidation (config change)", async () => {
    const { url, server } = await qbtServer();
    servers.push(server);
    const db = await freshDb();
    const id = await seedQbt(db, url);
    const providers = makeProviders(db);

    const a = await providers.configuredDownloadClients();
    providers.invalidateDownloadClient(id);
    const b = await providers.configuredDownloadClients();
    expect(a[0].provider).not.toBe(b[0].provider);
  });
});
