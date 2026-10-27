import Redis from 'ioredis'
import { config } from '../config'

let redis: Redis | null = null

export function getRedis(): Redis | null {
  if (!config.redis.url) return null
  if (!redis) {
    redis = new Redis(config.redis.url, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    })
  }
  return redis
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  const client = getRedis()
  if (!client) return null
  try {
    const data = await client.get(key)
    return data ? JSON.parse(data) : null
  } catch {
    return null
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds = 300): Promise<void> {
  const client = getRedis()
  if (!client) return
  try {
    await client.setex(key, ttlSeconds, JSON.stringify(value))
  } catch {
    // cache write failures are non-fatal
  }
}

export async function cacheDeletePattern(pattern: string): Promise<number> {
  const client = getRedis()
  if (!client) return 0
  try {
    const keys = await client.keys(pattern)
    if (keys.length === 0) return 0
    return await client.del(...keys)
  } catch {
    return 0
  }
}

/** Channel and key the worker uses to tell trading bots (surgebot/) which tokens a run newly flagged. */
export const FLAGS_CHANNEL = (chain: string) => `nodex:flags:${chain}`
export const FLAGS_LATEST_KEY = (chain: string) => `nodex:flags:${chain}:latest`

/**
 * Publishes a run's newly flagged tokens and keeps the latest run under a key, so a subscriber that was
 * disconnected during the publish still finds it. Failures are logged, never thrown: the pipeline must
 * not depend on a bot being reachable.
 */
export async function publishFlags(chain: string, payload: unknown, ttlSeconds = 3 * 3600): Promise<void> {
  const client = getRedis()
  if (!client) return
  try {
    const body = JSON.stringify(payload)
    await client.setex(FLAGS_LATEST_KEY(chain), ttlSeconds, body)
    await client.publish(FLAGS_CHANNEL(chain), body)
  } catch (error) {
    console.warn(`[redis] Could not publish ${chain} flags:`, error)
  }
}
