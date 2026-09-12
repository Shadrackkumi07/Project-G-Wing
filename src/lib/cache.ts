export interface CacheResult<T> {
  value: T;
  cached: boolean;
  ageSeconds: number;
}

interface Entry<T> {
  value: T;
  storedAt: number;
}

/**
 * In-memory TTL cache with in-flight de-duplication. The de-duplication matters
 * more than the caching here: X's API rate limits are low enough that two
 * concurrent agent requests for the same account must not become two upstream
 * calls.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly inflight = new Map<string, Promise<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get(key: string): CacheResult<T> | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;

    const ageMs = this.now() - entry.storedAt;
    if (ageMs >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return { value: entry.value, cached: true, ageSeconds: Math.floor(ageMs / 1000) };
  }

  set(key: string, value: T): void {
    this.entries.set(key, { value, storedAt: this.now() });
  }

  async load(key: string, loader: () => Promise<T>): Promise<CacheResult<T>> {
    const hit = this.get(key);
    if (hit) return hit;

    const existing = this.inflight.get(key);
    if (existing) {
      return { value: await existing, cached: true, ageSeconds: 0 };
    }

    const promise = loader();
    this.inflight.set(key, promise);
    try {
      const value = await promise;
      this.set(key, value);
      return { value, cached: false, ageSeconds: 0 };
    } finally {
      this.inflight.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
