// SPDX-License-Identifier: MIT
/**
 * Roadmap P1 (gap report B11): scheduler durability and command surface. Constructs
 * DrizzleJobStore/JobsService directly against a real file-backed DB (same pattern as
 * backup.spec.ts/housekeeping.spec.ts), bypassing Nest bootstrap — app.e2e-spec.ts already
 * exercises the full-app wiring.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, schema } from "@medianexus/database";
import { DrizzleJobStore } from "../src/jobs/drizzle-job.store";
import { JobsService } from "../src/jobs/jobs.service";

const dir = mkdtempSync(join(tmpdir(), "mn-jobs-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });

beforeAll(() => {
  process.env.MEDIA_NEXUS_SECRET = "test-secret-only";
});

let counter = 0;
async function freshService() {
  const handle = createDb(join(dir, `jb-${counter++}.db`));
  handle.runMigrations();
  handles.push(handle);
  const store = new DrizzleJobStore(handle.db);
  const service = new JobsService(store);
  return { db: handle.db, store, service };
}

const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();

async function seedDefinition(db: any, overrides: Partial<typeof schema.jobDefinition.$inferInsert> = {}) {
  const now = new Date().toISOString();
  await db.insert(schema.jobDefinition).values({
    id: "jobdef_test", key: "test.job", name: "Test job", schedule: "* * * * *",
    createdAt: now, updatedAt: now, ...overrides,
  } as never);
}

describe("JobsService", () => {
  it("definitions() includes a computed nextRunAt for an enabled scheduled job", async () => {
    const { db, service } = await freshService();
    await seedDefinition(db);
    const defs = await service.definitions();
    const def = defs.find((d) => d.key === "test.job")!;
    expect(def.nextRunAt).toBeDefined();
    expect(new Date(def.nextRunAt!).getTime()).not.toBeNaN();
  });

  it("does not surface a disabled job via definitions() (store-level filter, unchanged by this session)", async () => {
    const { db, service } = await freshService();
    await seedDefinition(db, { enabled: false } as never);
    const defs = await service.definitions();
    expect(defs.some((d) => d.key === "test.job")).toBe(false);
  });

  // Regression: schedule state used to live only in an in-process Map, so a restart with
  // no in-memory history fell back to "now - 60s" as the cron base and silently skipped any
  // window missed during downtime. lastExecutedAt is now persisted, so tick() correctly
  // detects overdue work after any amount of downtime.
  it("dispatches overdue work on tick() after simulated long downtime, using persisted lastExecutedAt", async () => {
    const { db, store, service } = await freshService();
    // every-minute schedule, but "last fired" 3 hours ago — badly overdue after a restart
    await seedDefinition(db, { schedule: "* * * * *", lastExecutedAt: hoursAgo(3) } as never);
    service.register("test.job", async () => ({ ok: true }));

    await service.tick();

    const runs = await store.recentRuns(10);
    expect(runs.some((r) => r.jobKey === "test.job" && r.trigger === "scheduled")).toBe(true);
  });

  it("does not re-dispatch a job whose next occurrence is still in the future", async () => {
    const { db, store, service } = await freshService();
    // daily schedule "just fired" — next occurrence is comfortably ~24h out regardless of
    // wall-clock second at test-run time (an every-minute schedule would be flaky near a
    // minute boundary)
    await seedDefinition(db, { schedule: "0 0 * * *", lastExecutedAt: new Date().toISOString() } as never);

    await service.tick();

    const runs = await store.recentRuns(10);
    expect(runs.some((r) => r.jobKey === "test.job")).toBe(false);
  });

  it("findRun() returns a real run by id and null for an unknown id", async () => {
    const { db, service } = await freshService();
    await seedDefinition(db);
    const run = await service.dispatch({ jobKey: "test.job", trigger: "manual", dueInMs: 60_000 });

    const found = await service.findRun(run.id);
    expect(found?.id).toBe(run.id);
    expect(await service.findRun("nope")).toBeNull();
  });

  it("cancel() flips a still-queued run to cancelled", async () => {
    const { db, service } = await freshService();
    await seedDefinition(db);
    const run = await service.dispatch({ jobKey: "test.job", trigger: "manual", dueInMs: 60_000 });

    const result = await service.cancel(run.id);
    expect(result).toEqual({ cancelled: true });

    const found = await service.findRun(run.id);
    expect(found?.status).toBe("cancelled");
  });
});
