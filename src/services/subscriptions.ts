import type Stripe from 'stripe'
import { getSupabaseAdmin } from './supabase'
import {
  getSubscriptionPeriodEnd,
  getSubscriptionPriceId,
  mapStripeStatus,
  planFromPriceId,
} from './stripe'
import type { SubscriptionPlan, SubscriptionStatus } from './users'
import { invalidateSubscriptionCache } from './subscription-cache'

interface SubscriptionRecord {
  user_id: string
  plan: SubscriptionPlan
  status: SubscriptionStatus
  current_period_end: string | null
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
}

export async function getSubscriptionByUserId(userId: string): Promise<SubscriptionRecord | null> {
  const admin = getSupabaseAdmin()
  const { data, error } = await admin
    .from('subscriptions')
    .select(
      'user_id, plan, status, current_period_end, stripe_customer_id, stripe_subscription_id'
    )
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error
  return data as SubscriptionRecord | null
}

export async function getSubscriptionByStripeCustomerId(
  customerId: string
): Promise<SubscriptionRecord | null> {
  const admin = getSupabaseAdmin()
  const { data, error } = await admin
    .from('subscriptions')
    .select(
      'user_id, plan, status, current_period_end, stripe_customer_id, stripe_subscription_id'
    )
    .eq('stripe_customer_id', customerId)
    .maybeSingle()

  if (error) throw error
  return data as SubscriptionRecord | null
}

export async function saveStripeCustomerId(userId: string, customerId: string): Promise<void> {
  const admin = getSupabaseAdmin()
  const { error } = await admin
    .from('subscriptions')
    .update({ stripe_customer_id: customerId })
    .eq('user_id', userId)

  if (error) throw error
}

export async function syncStripeSubscription(
  userId: string,
  subscription: Stripe.Subscription,
  fallbackPlan?: SubscriptionPlan
): Promise<void> {
  const priceId = getSubscriptionPriceId(subscription)
  const plan = planFromPriceId(priceId) ?? fallbackPlan ?? 'starter'
  const status = mapStripeStatus(subscription.status)
  const currentPeriodEnd = getSubscriptionPeriodEnd(subscription)

  const admin = getSupabaseAdmin()
  const { error } = await admin
    .from('subscriptions')
    .update({
      plan,
      status,
      current_period_end: currentPeriodEnd,
      stripe_subscription_id: subscription.id,
      stripe_customer_id:
        typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id,
    })
    .eq('user_id', userId)

  if (error) throw error
  invalidateSubscriptionCache(userId)
}

export async function markSubscriptionCanceled(userId: string): Promise<void> {
  const admin = getSupabaseAdmin()
  const { error } = await admin
    .from('subscriptions')
    .update({
      status: 'canceled',
      stripe_subscription_id: null,
      current_period_end: null,
    })
    .eq('user_id', userId)

  if (error) throw error
  invalidateSubscriptionCache(userId)
}

export async function markSubscriptionPastDue(userId: string): Promise<void> {
  const admin = getSupabaseAdmin()
  const { error } = await admin.from('subscriptions').update({ status: 'past_due' }).eq('user_id', userId)
  if (error) throw error
  invalidateSubscriptionCache(userId)
}

export async function activateSubscriptionPlan(
  userId: string,
  plan: SubscriptionPlan
): Promise<void> {
  const admin = getSupabaseAdmin()
  const { error } = await admin
    .from('subscriptions')
    .update({ plan, status: 'active' })
    .eq('user_id', userId)

  if (error) throw error
  invalidateSubscriptionCache(userId)
}
