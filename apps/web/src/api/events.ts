// SPDX-License-Identifier: MIT
import { apiKey, API_BASE } from "./client";

export interface DomainEvent {
  id: string;
  type: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

/** Map an event type to TanStack query keys that should refresh. */
export function eventTypeToQueryKeys(type: string): string[] {
  if (type.startsWith("acquisition")) return ["queue", "history", "wanted", "movies", "series", "job-runs", "indexer-stats"];
  if (type.startsWith("media.movie")) return ["movies"];
  if (type.startsWith("media.series")) return ["series", "wanted"];
  if (type.startsWith("system.job")) return ["job-runs"];
  if (type.startsWith("discovery")) return ["indexers", "indexer-stats"];
  if (type.startsWith("media.")) return ["movies", "series", "wanted"];
  return [];
}

/**
 * SSE reader implemented over fetch (so the X-Api-Key header is sent).
 * Reconnects with backoff while the app is mounted; one consumer keeps the stream open.
 */
export async function subscribeEvents(opts: { onEvent: (event: DomainEvent) => void; signal: AbortSignal; onStatus?: (connected: boolean) => void }): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/events`, { headers: { "x-api-key": apiKey() }, signal: opts.signal });
    if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
    opts.onStatus?.(true);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx = buf.indexOf("\n\n");
      while (idx >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = raw.split("\n").find((l) => l.startsWith("data:")) ;
        if (dataLine) {
          try { opts.onEvent(JSON.parse(dataLine.slice(5).trim()) as DomainEvent); } catch { /* skip */ }
        }
        idx = buf.indexOf("\n\n");
      }
    }
  } finally {
    opts.onStatus?.(false);
  }
}
