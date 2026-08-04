import { TtlCache } from './ttl-cache'

/**
 * Short-lived cache of "is this user entitled?".
 *
 * Every gated route re-read the subscription row from Supabase, which added a network round trip
 * to each dashboard page change, sort and filter toggle. It lives in its own module so the write
 * paths in `subscriptions.ts` / `users.ts` can invalidate it without importing
 * `subscription-access.ts` (which imports them, and would form a cycle).
 *
 * Every write to a subscription row must call `invalidateSubscriptionCache`, so plan changes are
 * never delayed by the TTL — the TTL only bounds staleness from changes made outside this process.
 */
const entitlementCache = new TtlCache<boolean>(60_000)

export function getCachedEntitlement(userId: string): boolean | undefined {
  return entitlementCache.get(userId)
}

export function setCachedEntitlement(userId: string, entitled: boolean): void {
  entitlementCache.set(userId, entitled)
}

export function invalidateSubscriptionCache(userId: string): void {
  entitlementCache.delete(userId)
}
