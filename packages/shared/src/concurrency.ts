// SPDX-License-Identifier: MIT

/**
 * Map `items` to promises with a bounded concurrency (a tiny p-limit/p-map stand-in —
 * the repo has no such dependency). Preserves input order. A rejected task rejects the
 * whole batch immediately (callers that must not abort should map to caught values first).
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R> | R,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
