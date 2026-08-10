// SPDX-License-Identifier: MIT
import type { ProviderKind } from "./contracts";

type AnyContract = { readonly key: string };

/**
 * Declarative provider registry. Core services look providers up by (kind, key);
 * new vendors register in their module without touching core logic.
 */
export class ProviderRegistry {
  private reg = new Map<string, Map<string, AnyContract>>();

  register(kind: ProviderKind, provider: AnyContract): void {
    if (!this.reg.has(kind)) this.reg.set(kind, new Map());
    this.reg.get(kind)!.set(provider.key, provider);
  }

  get<T extends AnyContract = AnyContract>(kind: ProviderKind, key: string): T | undefined {
    return this.reg.get(kind)?.get(key) as T | undefined;
  }

  require<T extends AnyContract = AnyContract>(kind: ProviderKind, key: string): T {
    const p = this.get<T>(kind, key);
    if (!p) throw new Error(`[registry] no ${kind} provider registered for key "${key}"`);
    return p;
  }

  list(kind: ProviderKind): AnyContract[] {
    return [...(this.reg.get(kind)?.values() ?? [])];
  }

  keys(kind: ProviderKind): string[] {
    return [...(this.reg.get(kind)?.keys() ?? [])];
  }

  clear(): void {
    this.reg.clear();
  }
}
