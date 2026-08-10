// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { JobEngine } from "./engine";
import { InMemoryJobStore } from "./inmemory";

function makeEngine(opts: { maxRetries?: number; handler?: any } = {}) {
  const store = new InMemoryJobStore();
  store.addDefinition({
    key: "demo.job", name: "Demo", schedule: "* * * * *", enabled: true,
    timeoutMs: 1000, maxRetries: opts.maxRetries ?? 0, retryBackoffMs: 30,
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
});
