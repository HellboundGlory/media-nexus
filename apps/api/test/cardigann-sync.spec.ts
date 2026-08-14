// SPDX-License-Identifier: MIT
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb, schema, type Db } from "@medianexus/database";
import { IndexersService } from "../src/indexers/indexers.service";
import { CardigannSyncService, type CardigannUpstreamSource, type UpstreamCardigannFile } from "../src/indexers/cardigann-sync.service";

const FIX = (name: string): string =>
  readFileSync(join(__dirname, "../../../packages/integrations/src/fixtures/cardigann", name), "utf8");

const CAPTCHA_YML = `id: captchasite
name: CaptchaSite
settings:
  - name: baseUrl
    type: text
login:
  method: post
  path: login
  captcha:
    type: image
    selector: img
    input: code
search:
  paths:
    - path: browse.php
  rows:
    selector: tr
  fields:
    title:
      selector: td
`;

const BAD_TPL_YML = `id: badtpl
name: BadTpl
settings:
  - name: baseUrl
    type: text
search:
  paths:
    - path: "x{{ printf .Keywords }}"
  rows:
    selector: tr
  fields:
    title:
      selector: td
`;

class MemSource implements CardigannUpstreamSource {
  constructor(private readonly files: Map<string, string>) {}
  async list(): Promise<UpstreamCardigannFile[]> {
    return [...this.files.keys()].map((name) => ({ name, rawUrl: `http://x/${name}` }));
  }
  async fetch(file: UpstreamCardigannFile): Promise<string> {
    const yml = this.files.get(file.name);
    if (yml === undefined) throw new Error(`missing ${file.name}`);
    return yml;
  }
}

const handles: { db: Db; close(): void }[] = [];
function makeDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), "mn-cg-sync-"));
  const handle = createDb(`file:${join(dir, "t.db")}`);
  handle.runMigrations();
  handles.push(handle as unknown as { db: Db; close(): void });
  return handle.db;
}
afterAll(() => {
  for (const h of handles) h.close?.();
});

async function defStatus(db: Db, key: string): Promise<{ supported?: boolean; reasons?: string[]; upstreamRemoved?: boolean }> {
  const row = await db.select().from(schema.indexerDefinition).where(eq(schema.indexerDefinition.key, key)).limit(1);
  return (row[0]?.capabilities as any)?.cardigannStatus ?? {};
}

describe("CardigannSyncService (media.definitionSync, roadmap D4 Stage 3)", () => {
  it("upserts built-in definitions from upstream and tags them supported", async () => {
    const db = makeDb();
    const svc = new CardigannSyncService(db as never);
    const source = new MemSource(new Map([
      ["limetorrents.yml", FIX("limetorrents.yml")],
      ["internetarchive.yml", FIX("internetarchive.yml")],
    ]));
    const summary = await svc.run(source);
    expect(summary.added).toBe(2);
    expect(summary.unsupported).toBe(0);
    const rows = await db.select().from(schema.indexerDefinition);
    const built = rows.filter((r) => r.builtIn && r.implementation === "cardigann");
    expect(built).toHaveLength(2);
    expect((await defStatus(db, "limetorrents")).supported).toBe(true);
    // idempotent: second run updates, not duplicates
    const s2 = await svc.run(source);
    expect(s2.added).toBe(0);
    expect(s2.updated).toBe(2);
  });

  it("tags unsupported definitions (captcha / unknown template function) without dropping them", async () => {
    const db = makeDb();
    const svc = new CardigannSyncService(db as never);
    await svc.run(new MemSource(new Map([
      ["captchasite.yml", CAPTCHA_YML],
      ["badtpl.yml", BAD_TPL_YML],
      ["internetarchive.yml", FIX("internetarchive.yml")],
    ])));
    expect((await defStatus(db, "captchasite")).supported).toBe(false);
    expect((await defStatus(db, "captchasite")).reasons?.join(" ")).toContain("captcha");
    expect((await defStatus(db, "badtpl")).supported).toBe(false);
    expect((await defStatus(db, "badtpl")).reasons?.join(" ")).toContain("printf");
    expect((await defStatus(db, "internetarchive")).supported).toBe(true);
  });

  it("never clobbers a user's custom definition on a key collision", async () => {
    const db = makeDb();
    const customYml = FIX("limetorrents.yml").replace("name: Mock", "name: UserCustom");
    await db.insert(schema.indexerDefinition).values({
      id: "idef-custom", key: "limetorrents", name: "UserCustom", protocol: "torrent", implementation: "cardigann",
      builtIn: false, capabilities: {}, categoryIds: [], cardigannYml: "CUSTOM-YML", createdAt: new Date().toISOString(),
    }).run();
    const summary = await new CardigannSyncService(db as never).run(
      new MemSource(new Map([["limetorrents.yml", FIX("limetorrents.yml")]])),
    );
    expect(summary.skippedCustom).toBe(1);
    const row = (await db.select().from(schema.indexerDefinition).where(eq(schema.indexerDefinition.key, "limetorrents")).limit(1))[0];
    expect(row.builtIn).toBe(false);
    expect(row.cardigannYml).toBe("CUSTOM-YML"); // untouched
    void customYml;
  });

  it("deprecates a live removed built-in in place (never hard-deletes while referenced) and removes an orphaned one", async () => {
    const db = makeDb();
    const now = new Date().toISOString();
    await db.insert(schema.indexerDefinition).values({
      id: "idef-live", key: "removedlive", name: "RemovedLive", protocol: "torrent", implementation: "cardigann",
      builtIn: true, capabilities: {}, categoryIds: [], cardigannYml: "OLD", createdAt: now,
    }).run();
    await db.insert(schema.indexerDefinition).values({
      id: "idef-orphan", key: "removedorphan", name: "RemovedOrphan", protocol: "torrent", implementation: "cardigann",
      builtIn: true, capabilities: {}, categoryIds: [], cardigannYml: "OLD", createdAt: now,
    }).run();
    // a configured indexer depends on the "live" key
    await db.insert(schema.indexer).values({
      id: "idx1", definitionKey: "removedlive", name: "LiveIdx", protocol: "torrent", enabled: true, implementation: "cardigann",
      settings: {}, priority: 25, status: "ok", tags: [], createdAt: now, updatedAt: now,
    }).run();

    const summary = await new CardigannSyncService(db as never).run(new MemSource(new Map([])));
    expect(summary.deprecated).toBe(1);
    expect(summary.removedOrphaned).toBe(1);
    // live built-in kept but flagged
    const live = (await db.select().from(schema.indexerDefinition).where(eq(schema.indexerDefinition.key, "removedlive")).limit(1))[0];
    expect(live).toBeTruthy();
    expect((live.capabilities as any).upstreamRemoved).toBe(true);
    expect((await defStatus(db, "removedlive")).supported).toBe(false);
    // orphaned removed
    const orphan = await db.select().from(schema.indexerDefinition).where(eq(schema.indexerDefinition.key, "removedorphan")).limit(1);
    expect(orphan).toHaveLength(0);
  });
});

describe("createDefinition built-in collision guard (Plan-agent D4 security fix)", () => {
  it("rejects overwriting a built-in definition on a key collision and rejects unsupported custom YAML", async () => {
    const db = makeDb();
    const now = new Date().toISOString();
    await db.insert(schema.indexerDefinition).values({
      id: "idef-builtin", key: "1337x", name: "1337x", protocol: "torrent", implementation: "cardigann",
      builtIn: true, capabilities: {}, categoryIds: [], cardigannYml: "REAL", createdAt: now,
    }).run();
    const svc = new IndexersService(db, {} as never, {} as never, {} as never, {} as never, {} as never);

    await expect(svc.createDefinition({ key: "1337x", name: "Collision", protocol: "torrent", cardigannYml: FIX("limetorrents.yml") }))
      .rejects.toMatchObject({ code: "CONFLICT" });

    // unsupported (bad template func) custom YAML is rejected, not stored
    await expect(svc.createDefinition({ key: "mycustom", name: "Bad", protocol: "torrent", cardigannYml: BAD_TPL_YML }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
