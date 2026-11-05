import { Router, Response, Request } from 'express'
import type Stripe from 'stripe'
import { config, resolveFrontendUrl } from '../config'
import { isDemoMode } from '../services/demo-auth'
import { authMiddleware, AuthRequest } from '../middleware/auth'
import { getUserProfile, updateUserProfile, type SubscriptionPlan } from '../services/users'
import {
  getStripe,
  isStripeConfigured,
  priceIdForPlan,
  getSubscriptionPeriodEnd,
} from '../services/stripe'
import {
  getSubscriptionByStripeCustomerId,
  getSubscriptionByUserId,
  markSubscriptionCanceled,
  markSubscriptionPastDue,
  saveStripeCustomerId,
  syncStripeSubscription,
  activateSubscriptionPlan,
} from '../services/subscriptions'
import { resolveEntitledSubscription } from '../services/subscription-access'

const router = Router()

function parsePlan(value: unknown): SubscriptionPlan | null {
  return value === 'starter' || value === 'pro' ? value : null
}

/** One flat plan. Shown until Stripe returns the live price, which replaces it below. */
const PLAN_PRICE_USD = 25

function formatPaymentMethod(
  paymentMethod: Stripe.PaymentMethod | null | undefined
): {
  brand: string
  last4: string
  expMonth: number
  expYear: number
} | null {
  if (!paymentMethod?.card) return null
  return {
    brand: paymentMethod.card.brand,
    last4: paymentMethod.card.last4,
    expMonth: paymentMethod.card.exp_month,
    expYear: paymentMethod.card.exp_year,
  }
}

async function resolvePaymentMethod(
  stripe: ReturnType<typeof getStripe>,
  customerId: string,
  subscriptionId: string | null
) {
  if (subscriptionId) {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['default_payment_method'],
    })
    const fromSubscription = subscription.default_payment_method
    if (fromSubscription && typeof fromSubscription !== 'string') {
      return formatPaymentMethod(fromSubscription)
    }
  }

  const customer = await stripe.customers.retrieve(customerId, {
    expand: ['invoice_settings.default_payment_method'],
  })
  if (customer.deleted) return null

  const fromCustomer = customer.invoice_settings?.default_payment_method
  if (fromCustomer && typeof fromCustomer !== 'string') {
    return formatPaymentMethod(fromCustomer)
  }

  const methods = await stripe.paymentMethods.list({
    customer: customerId,
    type: 'card',
    limit: 1,
  })

  const card = methods.data[0]
  return card ? formatPaymentMethod(card) : null
}

router.get('/subscription', authMiddleware, async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id
  const email = req.user!.email

  try {
    const entitled = await resolveEntitledSubscription(userId)
    const base = {
      plan: entitled.plan,
      status: entitled.status,
      currentPeriodEnd: entitled.currentPeriodEnd,
      amount: PLAN_PRICE_USD,
      interval: 'month' as const,
      paymentMethod: null as ReturnType<typeof formatPaymentMethod>,
    }

    if (isDemoMode() || !isStripeConfigured()) {
      return res.json({ ...base, demo: true })
    }

    const record = await getSubscriptionByUserId(userId)
    if (!record?.stripe_customer_id) {
      return res.json(base)
    }

    const stripe = getStripe()
    let currentPeriodEnd = entitled.currentPeriodEnd

    if (record.stripe_subscription_id) {
      const subscription = await stripe.subscriptions.retrieve(record.stripe_subscription_id)
      currentPeriodEnd = getSubscriptionPeriodEnd(subscription)

      const price = subscription.items.data[0]?.price
      if (price?.unit_amount) {
        base.amount = price.unit_amount / 100
      }
    }

    const paymentMethod = await resolvePaymentMethod(
      stripe,
      record.stripe_customer_id,
      record.stripe_subscription_id
    )

    res.json({
      ...base,
      currentPeriodEnd,
      paymentMethod,
    })
  } catch (error) {
    console.error('Billing subscription fetch failed:', error)
    res.status(500).json({ message: 'Failed to load billing details' })
  }
})

router.post('/checkout', authMiddleware, async (req: AuthRequest, res: Response) => {
  const plan = parsePlan(req.body.plan)
  if (!plan) return res.status(400).json({ message: 'Invalid plan' })

  const userId = req.user!.id
  const email = req.user!.email
  const frontendUrl = resolveFrontendUrl(req)

  if (isDemoMode() || !isStripeConfigured()) {
    if (isDemoMode()) {
      await updateUserProfile(userId, email, { plan })
    } else {
      await activateSubscriptionPlan(userId, plan)
    }
    const profile = await getUserProfile(userId, email)
    return res.json({
      url: `${frontendUrl}/pricing?updated=1`,
      demo: true,
      updated: true,
      user: profile,
    })
  }

  try {
    const stripe = getStripe()
    const existing = await getSubscriptionByUserId(userId)

    if (
      existing &&
      (existing.status === 'active' || existing.status === 'trialing') &&
      existing.plan === plan
    ) {
      return res.status(400).json({ message: 'You are already subscribed to this plan' })
    }

    if (
      existing?.stripe_subscription_id &&
      (existing.status === 'active' || existing.status === 'trialing')
    ) {
      const subscription = await stripe.subscriptions.retrieve(existing.stripe_subscription_id)
      const itemId = subscription.items.data[0]?.id
      if (!itemId) {
        return res.status(500).json({ message: 'Subscription item not found' })
      }

      const updated = await stripe.subscriptions.update(existing.stripe_subscription_id, {
        items: [{ id: itemId, price: priceIdForPlan(plan) }],
        proration_behavior: 'create_prorations',
        metadata: { userId, plan },
      })
      await syncStripeSubscription(userId, updated, plan)
      const profile = await getUserProfile(userId, email)
      return res.json({ updated: true, user: profile })
    }

    let customerId = existing?.stripe_customer_id ?? undefined

    if (!customerId) {
      const customer = await stripe.customers.create({
        email,
        metadata: { userId },
      })
      customerId = customer.id
      await saveStripeCustomerId(userId, customerId)
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceIdForPlan(plan), quantity: 1 }],
      success_url: `${frontendUrl}/pricing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/pricing?canceled=1`,
      allow_promotion_codes: true,
      client_reference_id: userId,
      metadata: { userId, plan },
      subscription_data: {
        metadata: { userId, plan },
      },
    })

    if (!session.url) {
      return res.status(500).json({ message: 'Unable to create checkout session' })
    }

    res.json({ url: session.url })
  } catch (error) {
    console.error('Stripe checkout failed:', error)
    res.status(500).json({ message: 'Failed to start checkout' })
  }
})

router.post('/portal', authMiddleware, async (req: AuthRequest, res: Response) => {
  if (isDemoMode() || !isStripeConfigured()) {
    return res.status(400).json({ message: 'Billing portal is not available in demo mode' })
  }

  const frontendUrl = resolveFrontendUrl(req)

  try {
    const subscription = await getSubscriptionByUserId(req.user!.id)
    if (!subscription?.stripe_customer_id) {
      return res.status(400).json({ message: 'No billing account found. Subscribe to a plan first.' })
    }

    const stripe = getStripe()
    const session = await stripe.billingPortal.sessions.create({
      customer: subscription.stripe_customer_id,
      return_url: `${frontendUrl}/billing`,
    })

    res.json({ url: session.url })
  } catch (error) {
    console.error('Stripe portal failed:', error)
    res.status(500).json({ message: 'Failed to open billing portal' })
  }
})

router.get('/session/:sessionId', authMiddleware, async (req: AuthRequest, res: Response) => {
  const sessionId = Array.isArray(req.params.sessionId) ? req.params.sessionId[0] : req.params.sessionId
  if (!sessionId) return res.status(400).json({ message: 'Session id is required' })

  if (isDemoMode() || !isStripeConfigured()) {
    const profile = await getUserProfile(req.user!.id, req.user!.email)
    return res.json({ profile, demo: true })
  }

  try {
    const stripe = getStripe()
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['subscription'],
    })

    if (session.client_reference_id !== req.user!.id && session.metadata?.userId !== req.user!.id) {
      return res.status(403).json({ message: 'Session does not belong to this user' })
    }

    const subscription = session.subscription
    if (subscription && typeof subscription !== 'string') {
      const fallbackPlan = parsePlan(session.metadata?.plan) ?? undefined
      await syncStripeSubscription(req.user!.id, subscription, fallbackPlan)
    }

    const profile = await getUserProfile(req.user!.id, req.user!.email)
    res.json({ profile })
  } catch (error) {
    console.error('Stripe session verify failed:', error)
    res.status(500).json({ message: 'Failed to verify checkout session' })
  }
})

export async function billingWebhook(req: Request, res: Response) {
  if (!isStripeConfigured()) {
    return res.status(400).send('Stripe is not configured')
  }

  const signature = req.headers['stripe-signature']
  if (!signature || Array.isArray(signature)) {
    return res.status(400).send('Missing stripe-signature header')
  }

  let event: Stripe.Event

  try {
    const stripe = getStripe()
    event = stripe.webhooks.constructEvent(req.body, signature, config.stripe.webhookSecret)
  } catch (error) {
    console.error('Stripe webhook signature verification failed:', error)
    return res.status(400).send('Webhook signature verification failed')
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        const userId = session.metadata?.userId ?? session.client_reference_id
        if (!userId) break

        if (session.subscription && typeof session.subscription === 'string') {
          const stripe = getStripe()
          const subscription = await stripe.subscriptions.retrieve(session.subscription)
          const fallbackPlan = parsePlan(session.metadata?.plan) ?? undefined
          await syncStripeSubscription(userId, subscription, fallbackPlan)
        }
        break
      }
      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription
        const userId = subscription.metadata?.userId
        if (userId) {
          await syncStripeSubscription(userId, subscription)
          break
        }

        const customerId =
          typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id
        const record = await getSubscriptionByStripeCustomerId(customerId)
        if (record) await syncStripeSubscription(record.user_id, subscription)
        break
      }
      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription
        const userId = subscription.metadata?.userId
        if (userId) {
          await markSubscriptionCanceled(userId)
          break
        }

        const customerId =
          typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id
        const record = await getSubscriptionByStripeCustomerId(customerId)
        if (record) await markSubscriptionCanceled(record.user_id)
        break
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice
        const customerId =
          typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id
        if (!customerId) break

        const record = await getSubscriptionByStripeCustomerId(customerId)
        if (record) await markSubscriptionPastDue(record.user_id)
        break
      }
      default:
        break
    }

    res.json({ received: true })
  } catch (error) {
    console.error('Stripe webhook handler failed:', error)
    res.status(500).json({ message: 'Webhook handler failed' })
  }
}

export default router
