/**
 * Tiny in-process TTL cache (per server instance) — for values that are
 * expensive to compute but tolerate short staleness (activity counts, org
 * config). Modeled on the org-membership cache. Not shared across instances;
 * a restart clears it, which is always safe.
 */
export interface TtlCache<V> {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
  delete(key: string): void;
  clear(): void;
}

export function createTtlCache<V>(ttlMs: number, maxEntries = 1000): TtlCache<V> {
  const store = new Map<string, { value: V; exp: number }>();
  return {
    get(key) {
      const hit = store.get(key);
      if (!hit) return undefined;
      if (Date.now() > hit.exp) {
        store.delete(key);
        return undefined;
      }
      return hit.value;
    },
    set(key, value) {
      // Bound memory: evict the oldest insertion when full.
      if (store.size >= maxEntries && !store.has(key)) {
        const oldest = store.keys().next().value;
        if (oldest !== undefined) store.delete(oldest);
      }
      store.set(key, { value, exp: Date.now() + ttlMs });
    },
    delete(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
}
