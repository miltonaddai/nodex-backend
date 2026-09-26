import type { PipelineSchedule } from '../services/clickhouse'
import { cacheGet, cacheSet } from '../services/redis'

/**
 * Serves worker-produced snapshots without waking ClickHouse on every visit.
 *
 * The ranked tables only change when the worker's pipeline runs, and ClickHouse Cloud idles
 * between runs. Waking it takes a minute or more, so a plain short-TTL cache made the first
 * visitor after each quiet period wait that long. Instead each response is kept until the next
 * scheduled run. After that it is still served immediately while a background refresh fetches the
 * new data, so a visitor only ever waits when nothing has been cached for that view yet.
 */

interface Snapshot<T> {
  value: T
  /** Epoch ms until which the value cannot have changed. */
  freshUntil: number
}

/** How long a snapshot is kept for stale serving. Long enough to survive a quiet week. */
const RETENTION_SECONDS = 7 * 24 * 60 * 60
/** Freshness while a run is writing, or when the schedule is unknown. */
const SHORT_FRESHNESS_MS = 5 * 60 * 1000

const inflight = new Map<string, Promise<unknown>>()

/** When a snapshot loaded now stops being current, given the worker's recorded schedule. */
export function snapshotFreshUntil(schedule: PipelineSchedule | null): number {
  const shortly = Date.now() + SHORT_FRESHNESS_MS
  if (!schedule?.nextUpdate || schedule.running) return shortly
  return Math.max(Date.parse(schedule.nextUpdate), shortly)
}

async function refresh<T>(
  key: string,
  load: () => Promise<Snapshot<T> | null>
): Promise<T | null> {
  const existing = inflight.get(key) as Promise<T | null> | undefined
  if (existing) return existing
  const pending = (async () => {
    const snapshot = await load()
    if (snapshot) await cacheSet(key, snapshot, RETENTION_SECONDS)
    return snapshot?.value ?? null
  })().finally(() => inflight.delete(key))
  inflight.set(key, pending)
  return pending
}

/**
 * Returns the cached value when it is current, the stale value plus a background refresh when a
 * run has happened since, and waits on `load` only when nothing is cached. A null from `load` is
 * not cached.
 */
export async function getSnapshot<T>(
  key: string,
  load: () => Promise<Snapshot<T> | null>
): Promise<T | null> {
  const cached = await cacheGet<Snapshot<T>>(key)
  if (cached && Date.now() < cached.freshUntil) return cached.value
  if (cached) {
    refresh(key, load).catch((error) => console.warn(`[snapshot-cache] Refresh failed for ${key}:`, error))
    return cached.value
  }
  return refresh(key, load)
}
