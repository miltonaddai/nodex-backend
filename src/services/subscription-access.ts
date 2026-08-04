import type { SubscriptionPlan, SubscriptionStatus, UserSubscription } from './users'
import { getSupabaseAdmin } from './supabase'
import { getSubscriptionByUserId } from './subscriptions'
import {
  getCachedEntitlement,
  invalidateSubscriptionCache,
  setCachedEntitlement,
} from './subscription-cache'

export { invalidateSubscriptionCache }

function inactiveSubscription(plan: SubscriptionPlan = 'starter'): UserSubscription {
  return { plan, status: 'canceled', currentPeriodEnd: null }
}

export async function revokeInvalidSubscriptionAccess(userId: string): Promise<void> {
  const admin = getSupabaseAdmin()
  const { error } = await admin
    .from('subscriptions')
    .update({ status: 'canceled', current_period_end: null })
    .eq('user_id', userId)

  if (error) throw error
  invalidateSubscriptionCache(userId)
}

/**
 * Returns the subscription the user is actually entitled to.
 * When Stripe is configured, active/trialing requires a stripe_subscription_id.
 */
export async function resolveEntitledSubscription(userId: string): Promise<UserSubscription> {
  const record = await getSubscriptionByUserId(userId)
  if (!record) return inactiveSubscription()

  const { isDemoMode } = await import('./demo-auth')
  const { isStripeConfigured } = await import('./stripe')

  if (isDemoMode()) {
    return {
      plan: record.plan,
      status: record.status,
      currentPeriodEnd: record.current_period_end,
    }
  }

  const hasPaidStatus = record.status === 'active' || record.status === 'trialing'
  const hasStripeSubscription = Boolean(record.stripe_subscription_id)

  if (isStripeConfigured()) {
    if (!hasStripeSubscription) {
      if (hasPaidStatus) {
        await revokeInvalidSubscriptionAccess(userId)
      }
      return inactiveSubscription(record.plan)
    }

    if (!hasPaidStatus) {
      return inactiveSubscription(record.plan)
    }

    return {
      plan: record.plan,
      status: record.status,
      currentPeriodEnd: record.current_period_end,
    }
  }

  // Stripe not configured (local dev without keys): only honor active if explicitly set via demo checkout
  if (!hasPaidStatus) {
    return inactiveSubscription(record.plan)
  }

  return {
    plan: record.plan,
    status: record.status,
    currentPeriodEnd: record.current_period_end,
  }
}

export async function isUserSubscriptionEntitled(userId: string): Promise<boolean> {
  const cached = getCachedEntitlement(userId)
  if (cached !== undefined) return cached

  const subscription = await resolveEntitledSubscription(userId)
  const entitled = subscription.status === 'active' || subscription.status === 'trialing'
  setCachedEntitlement(userId, entitled)
  return entitled
}

export function isEntitledStatus(status: SubscriptionStatus): boolean {
  return status === 'active' || status === 'trialing'
}
