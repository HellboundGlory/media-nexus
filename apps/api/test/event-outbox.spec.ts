// SPDX-License-Identifier: MIT
/** P2 item 9 — durable event outbox + SSE `Last-Event-ID` replay (gap report H6). */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@medianexus/database";
import { EventBus } from "@medianexus/events";
import { EventsService } from "../src/events/events.service";
import { RealtimeService } from "../src/realtime/realtime.service";

const dir = mkdtempSync(join(tmpdir(), "mn-outbox-"));
let handle: ReturnType<typeof createDb>;
let db: ReturnType<typeof createDb>["db"];

beforeAll(async () => {
  handle = createDb(join(dir, "o.db"));
  handle.runMigrations();
  db = handle.db;
});
afterAll(() => handle.close());

const tick = () => new Promise((r) => setTimeout(r, 30));

describe("event outbox", () => {
  it("persists every publish to the outbox, even with zero live subscribers", async () => {
    const svc = new EventsService(new EventBus(), db);
    const ev = svc.publish("media.movie.removed", { title: "x" }, { aggType: "movie", aggId: "m1" });
    await svc.flushOutbox();

    const rows = await db.select().from(schema.eventOutbox).where(eq(schema.eventOutbox.id, ev.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("media.movie.removed");
    expect(rows[0].correlationId).toBe(ev.correlationId);
    expect(rows[0].aggregate).toEqual({ aggType: "movie", aggId: "m1" });
    expect(rows[0].payload).toEqual({ title: "x" });
  });

  it("prunes outbox rows beyond the retention window", async () => {
    const svc = new EventsService(new EventBus(), db);
    const ev = svc.publish("media.series.added", { title: "old" });
    await svc.flushOutbox();
    await db.update(schema.eventOutbox)
      .set({ occurredAt: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString() })
      .where(eq(schema.eventOutbox.id, ev.id));

    const deleted = await svc.pruneOutbox(14);
    expect(deleted).toBeGreaterThanOrEqual(1);
    const remaining = await db.select().from(schema.eventOutbox).where(eq(schema.eventOutbox.id, ev.id));
    expect(remaining).toHaveLength(0);
  });
});

describe("SSE Last-Event-ID replay", () => {
  it("replays exactly the events after the cursor, then continues live with no duplicates", async () => {
    const bus = new EventBus();
    const svc = new EventsService(bus, db);
    const e1 = svc.publish("media.movie.added", { title: "1" });
    const e2 = svc.publish("media.movie.added", { title: "2" });
    const e3 = svc.publish("media.movie.added", { title: "3" });
    await svc.flushOutbox();

    const realtime = new RealtimeService(bus, db);
    realtime.onModuleInit();

    const received: string[] = [];
    const sub = realtime.streamSince(e1.id).subscribe((m) => { if (m.id) received.push(m.id); });
    await tick();

    // the gap after e1, in order, exactly
    expect(received).toEqual([e2.id, e3.id]);

    // continue on the live stream; no re-delivery of the replayed events
    const e4 = svc.publish("media.movie.added", { title: "4" });
    await svc.flushOutbox();
    await tick();
    expect(received).toEqual([e2.id, e3.id, e4.id]);

    sub.unsubscribe();
  });
});
