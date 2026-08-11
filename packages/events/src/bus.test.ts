// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";
import { EventBus } from "./bus";
import { domainEvent, EventTypes } from "./envelope";

describe("EventBus", () => {
  it("delivers to typed handlers and wildcard handlers", async () => {
    const bus = new EventBus();
    const typed = vi.fn();
    const wild = vi.fn();
    bus.on(EventTypes.MovieAdded, typed, { async: false });
    bus.onAny(wild, { async: false });
    await bus.emit(domainEvent(EventTypes.MovieAdded, { movieId: "m1" }, { aggId: "m1" }));
    expect(typed).toHaveBeenCalledTimes(1);
    expect(wild).toHaveBeenCalledTimes(1);
    expect(typed.mock.calls[0][0].payload).toEqual({ movieId: "m1" });
  });

  it("isolates handler errors from the publisher", async () => {
    const bus = new EventBus();
    const boom = vi.fn(() => { throw new Error("handler boom"); });
    bus.on(EventTypes.MovieAdded, boom);
    await expect(bus.emit(domainEvent(EventTypes.MovieAdded, {}))).resolves.toBeUndefined();
  });

  it("unsubscribes cleanly", async () => {
    const bus = new EventBus();
    const h = vi.fn();
    const off = bus.on(EventTypes.MovieAdded, h, { async: false });
    off();
    await bus.emit(domainEvent(EventTypes.MovieAdded, {}));
    expect(h).not.toHaveBeenCalled();
  });

  it("envelope carries correlationId + aggregate", () => {
    const ev = domainEvent(EventTypes.MovieAdded, { movieId: "m1" }, { aggType: "movie", aggId: "m1" });
    expect(ev.type).toBe(EventTypes.MovieAdded);
    expect(ev.version).toBe(1);
    expect(ev.id).toBeTruthy();
    expect(ev.correlationId).toBeTruthy();
    expect(ev.aggregate.aggId).toBe("m1");
  });
});
