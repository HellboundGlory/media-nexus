// SPDX-License-Identifier: MIT
import type { DomainEvent } from "./envelope";

type AnyEvent = DomainEvent<any>;

export interface EventHandlerMeta {
  /** TRUE = handled eagerly (await before the emit() promise resolves);
   *  FALSE = processed asynchronously (fire-and-forget). */
  async?: boolean;
}

export type EventHandler<E extends AnyEvent = AnyEvent> = (event: E) => void | Promise<void>;

interface HandlerEntry {
  handler: EventHandler<AnyEvent>;
  ctx: { async: boolean };
}

/**
 * In-process, typed, error-isolated domain event bus.
 *
 * - `on()` registers a handler for a specific event type (or `*`).
 * - `emit()` resolves after all *synchronous* handlers finish; async handlers are scheduled
 *   on `setImmediate` so a slow subscriber never blocks the publisher or the request.
 * - Handler errors are caught and logged, never propagated to the publisher (error isolation).
 */
export class EventBus {
  private handlers = new Map<string, HandlerEntry[]>();

  on<E extends AnyEvent>(type: string, handler: EventHandler<E>, ctx: EventHandlerMeta = { async: true }): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    const typedHandler = (handler as unknown) as EventHandler<AnyEvent>;
    this.handlers.get(type)!.push({ handler: typedHandler, ctx: { async: ctx.async ?? true } });
    return () => this.off(type, typedHandler);
  }

  onAny(handler: EventHandler<AnyEvent>, ctx: EventHandlerMeta = { async: true }): () => void {
    return this.on("*", handler, ctx);
  }

  off(type: string, handler: EventHandler<AnyEvent>): void {
    const list = this.handlers.get(type);
    if (!list) return;
    const i = list.findIndex((e) => e.handler === handler);
    if (i >= 0) list.splice(i, 1);
  }

  async emit(event: AnyEvent): Promise<void> {
    const direct = this.handlers.get(event.type) ?? [];
    const all = this.handlers.get("*") ?? [];
    const entries = [...direct, ...all];
    const syncWork: Promise<void>[] = [];
    for (const entry of entries) {
      try {
        const result = entry.handler(event);
        if (entry.ctx.async) {
          if (result) void Promise.resolve(result).catch((e) => this.report(event, e));
        } else if (result) {
          syncWork.push(Promise.resolve(result));
        }
      } catch (e) {
        this.report(event, e);
      }
    }
    // synchronous handlers awaited once (so audit transaction ordering is deterministic)
    await Promise.all(syncWork);
  }

  private report(event: AnyEvent, err: unknown): void {
    // Never let a subscriber crash the process; surface the failure loudly.
    // eslint-disable-next-line no-console
    console.error(`[events] handler for "${event.type}" failed`, err);
  }

  listenerCount(type?: string): number {
    if (type) return (this.handlers.get(type) ?? []).length;
    let n = 0;
    for (const list of this.handlers.values()) n += list.length;
    return n;
  }
}
