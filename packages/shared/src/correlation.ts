// SPDX-License-Identifier: MIT
import { AsyncLocalStorage } from "node:async_hooks";
import { newRequestId } from "./id";

/** AsyncLocalStorage-backed correlation context.
 *  The API middleware seeds it per-request; jobs/events/audit inherit it automatically. */
export interface CorrelationContext {
  requestId: string;
}

export const correlationStore = new AsyncLocalStorage<CorrelationContext>();

export function runWithCorrelation<T>(ctx: CorrelationContext, fn: () => T): T {
  return correlationStore.run(ctx, fn);
}

export function getCorrelationId(): string | undefined {
  return correlationStore.getStore()?.requestId;
}

export function ensureCorrelationId(): string {
  return getCorrelationId() ?? newRequestId();
}
