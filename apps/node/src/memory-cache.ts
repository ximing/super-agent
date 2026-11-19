export type MemoryCacheLookup = { hit: true; stale: boolean; observed_at: string; value: unknown } | { hit: false }
interface Entry { value: unknown; observed_at: string; bytes: number; generation: number }

/** Bounded task cache. Stale and offline hits are labeled and cannot be read as current facts. */
export class MemoryCache {
  private entries = new Map<string, Entry>();
  private bytes = 0;
  generation = 1;
  offline = false;
  constructor(private readonly limits = { maxEntries: 64, maxBytes: 1_000_000, ttlMs: 5 * 60_000 }) {}
  markOffline(offline = true): void { this.offline = offline; }
  invalidate(): void { this.generation += 1; this.entries.clear(); this.bytes = 0; }
  drop(kind: 'search' | 'read', fingerprint: string): void {
    for (const [key, entry] of this.entries) if (key.startsWith(`${kind}\0${fingerprint}\0`)) { this.bytes -= entry.bytes; this.entries.delete(key); }
  }
  private storageKey(kind: string, fingerprint: string): string { return `${kind}\0${fingerprint}\0${this.generation}`; }
  lookup(kind: 'search' | 'read', fingerprint: string, now = Date.now()): MemoryCacheLookup {
    const exact = this.entries.get(this.storageKey(kind, fingerprint));
    const fallback = exact ?? [...this.entries.entries()].reverse().find(([key]) => key.startsWith(`${kind}\0${fingerprint}\0`))?.[1];
    if (!fallback) return { hit: false };
    const expired = now - Date.parse(fallback.observed_at) > this.limits.ttlMs;
    const stale = this.offline || expired || fallback.generation !== this.generation;
    return { hit: true, stale, observed_at: fallback.observed_at, value: stale ? this.staleValue(fallback.value, fallback.observed_at, this.offline ? 'offline' : expired ? 'expired_cache' : 'invalidated') : fallback.value };
  }
  store(kind: 'search' | 'read', fingerprint: string, value: unknown, now = new Date().toISOString()): void {
    const key = this.storageKey(kind, fingerprint);
    const bytes = Buffer.byteLength(JSON.stringify(value));
    const previous = this.entries.get(key);
    if (previous) this.bytes -= previous.bytes;
    this.entries.set(key, { value, observed_at: now, bytes, generation: this.generation });
    this.bytes += bytes;
    while (this.entries.size > this.limits.maxEntries || this.bytes > this.limits.maxBytes) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.bytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
  }
  private staleValue(value: unknown, observedAt: string, reason: string): Record<string, unknown> {
    const record: Record<string, unknown> = value && typeof value === 'object' ? { ...(value as Record<string, unknown>) } : { value };
    record.fresh = false; record.stale = true; record.stale_reason = reason; record.observed_at = observedAt;
    record.cache_notice = '缓存已过期或节点离线，不能当作当前事实';
    if (Array.isArray(record.items)) record.items = record.items.map(item => item && typeof item === 'object' ? { ...(item as Record<string, unknown>), fresh: false, stale: true, stale_reason: reason, content: null } : item);
    if ('content' in record) record.content = null;
    return record;
  }
}
