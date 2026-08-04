/**
 * Tiny in-process TTL cache.
 *
 * Used for per-request lookups that hit Supabase on every single API call (token -> user,
 * user -> entitlement). Those were ~250ms of every ~400ms dashboard request, paid again on
 * every page change, sort and filter toggle. This is deliberately in-process rather than in
 * Redis: the values are small, cheap to recompute, and a Redis round trip to Upstash (~80ms)
 * would eat most of the win.
 */
export class TtlCache<T> {
  private entries = new Map<string, { value: T; expiresAt: number }>()

  constructor(private readonly ttlMs: number, private readonly maxEntries = 5000) {}

  get(key: string): T | undefined {
    const hit = this.entries.get(key)
    if (!hit) return undefined
    if (Date.now() > hit.expiresAt) {
      this.entries.delete(key)
      return undefined
    }
    return hit.value
  }

  set(key: string, value: T): void {
    // Bound memory: entries are insertion-ordered, so the oldest key is the first one.
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (!oldest.done) this.entries.delete(oldest.value)
    }
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs })
  }

  delete(key: string): void {
    this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }
}
