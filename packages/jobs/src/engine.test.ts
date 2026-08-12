// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { JobEngine } from "./engine";
import { InMemoryJobStore } from "./inmemory";

function makeEngine(opts: { maxRetries?: number; handler?: any; timeoutMs?: number } = {}) {
  const store = new InMemoryJobStore();
  store.addDefinition({
    key: "demo.job", name: "Demo", schedule: "* * * * *", enabled: true,
    timeoutMs: opts.timeoutMs ?? 1000, maxRetries: opts.maxRetries ?? 0, retryBackoffMs: 30,
    priority: 1, concurrencyLimit: 1,
  });
  const engine = new JobEngine({ store, maxWorkers: 1 });
  if (opts.handler) engine.register("demo.job", opts.handler);
  return { store, engine };
}

describe("JobEngine", () => {
  it("runs a handler to success and persists result", async () => {
    const { store, engine } = makeEngine({ handler: async (c) => {
      await c.progress(50, "halfway");
      return { ok: true };
    }});
    const run = await engine.dispatch({ jobKey: "demo.job", trigger: "scheduled", payload: { a: 1 } });
    await engine.drain();
    await engine.waitIdle();
    const record = store.runs.get(run.id)!;
    expect(record.status).toBe("succeeded");
    expect(record.progress).toBe(50);
    expect(record.result).toEqual({ ok: true });
  });

  it("retries with backoff then fails permanently after maxRetries", async () => {
    const { store, engine } = makeEngine({ maxRetries: 1, handler: async () => { throw new Error("boom"); } });
    const _run = await engine.dispatch({ jobKey: "demo.job" });
    await engine.drain();
    await engine.waitIdle();
    // first failure -> retrying (a second run row with attempt 2)
    const retries = [...store.runs.values()].filter((r) => r.status === "retrying");
    expect(retries.length).toBe(1);
    // make it due now and drain again -> attempt 2 fails permanently (both rows terminal)
    for (const r of retries) store.runs.set(r.id, { ...r, dueAt: new Date(0).toISOString() });
    await engine.drain();
    await engine.waitIdle();
    expect([...store.runs.values()].filter((r) => r.status === "failed").length).toBe(2);
  });

  it("respects side-effect-free dispatch for unknown key", async () => {
    const store = new InMemoryJobStore();
    const engine = new JobEngine({ store });
    await expect(engine.dispatch({ jobKey: "nope" })).rejects.toThrow(/no job definition/);
  });

  // Regression: the timeout used to only abort an AbortSignal that handlers never read,
  // so a handler ignoring ctx.signal ran forever and never released its worker slot.
  it("times out a handler that ignores the abort signal", async () => {
    const { store, engine } = makeEngine({
      timeoutMs: 40,
      handler: () => new Promise(() => { /* never settles, never reads ctx.signal */ }),
    });
    const run = await engine.dispatch({ jobKey: "demo.job" });
    await engine.drain();
    await engine.waitIdle();
    const record = store.runs.get(run.id)!;
    expect(record.status).toBe("timed_out");
    expect(record.error).toMatch(/timeout/i);
  });

  // Regression: a hung handler holding every worker slot froze the whole engine, so no
  // further job of any kind could be drained.
  it("frees its worker slot after a timeout so later jobs still run", async () => {
    const { store, engine } = makeEngine({
      timeoutMs: 40,
      handler: () => new Promise(() => {}),
    });
    engine.register("demo.job2", async () => ({ ran: true }));
    store.addDefinition({
      key: "demo.job2", name: "Demo 2", schedule: "* * * * *", enabled: true,
      timeoutMs: 1000, maxRetries: 0, retryBackoffMs: 0, priority: 1, concurrencyLimit: 1,
    });

    await engine.dispatch({ jobKey: "demo.job" });
    await engine.drain();
    await engine.waitIdle();

    const second = await engine.dispatch({ jobKey: "demo.job2" });
    await engine.drain();
    await engine.waitIdle();
    expect(store.runs.get(second.id)!.status).toBe("succeeded");
  });

  it("does not retry a timed-out run", async () => {
    const { store, engine } = makeEngine({
      timeoutMs: 40,
      maxRetries: 3,
      handler: () => new Promise(() => {}),
    });
    await engine.dispatch({ jobKey: "demo.job" });
    await engine.drain();
    await engine.waitIdle();
    expect([...store.runs.values()].filter((r) => r.status === "retrying").length).toBe(0);
  });
});
