import Stripe from 'stripe'
import { config } from '../config'
import type { SubscriptionPlan } from './users'

let stripe: Stripe | null = null

export function getStripe(): Stripe {
  if (!config.stripe.secretKey) {
    throw new Error('Stripe is not configured')
  }
  if (!stripe) {
    stripe = new Stripe(config.stripe.secretKey)
  }
  return stripe
}

export function isStripeConfigured(): boolean {
  return Boolean(
    config.stripe.secretKey &&
      config.stripe.webhookSecret &&
      config.stripe.priceStarter &&
      config.stripe.pricePro
  )
}

export function priceIdForPlan(plan: SubscriptionPlan): string {
  return plan === 'pro' ? config.stripe.pricePro : config.stripe.priceStarter
}

export function planFromPriceId(priceId: string | null | undefined): SubscriptionPlan | null {
  if (!priceId) return null
  if (priceId === config.stripe.pricePro) return 'pro'
  if (priceId === config.stripe.priceStarter) return 'starter'
  return null
}

export function mapStripeStatus(
  status: Stripe.Subscription.Status
): 'active' | 'canceled' | 'past_due' | 'trialing' {
  switch (status) {
    case 'active':
      return 'active'
    case 'trialing':
      return 'trialing'
    case 'past_due':
    case 'unpaid':
      return 'past_due'
    default:
      return 'canceled'
  }
}

export function getSubscriptionPeriodEnd(subscription: Stripe.Subscription): string | null {
  const itemEnd = subscription.items?.data?.[0]?.current_period_end
  const end = itemEnd ?? (subscription as Stripe.Subscription & { current_period_end?: number }).current_period_end
  if (!end) return null
  return new Date(end * 1000).toISOString()
}

export function getSubscriptionPriceId(subscription: Stripe.Subscription): string | null {
  return subscription.items.data[0]?.price?.id ?? null
}
