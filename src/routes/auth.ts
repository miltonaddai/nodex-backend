import { Router, Request, Response } from 'express'
import { getSupabase } from '../services/supabase'
import {
  createDemoToken,
  getOrCreateDemoUser,
  isDemoMode,
} from '../services/demo-auth'
import { isStripeConfigured } from '../services/stripe'
import {
  ensureUserRecords,
  getUserProfile,
  updateUserProfile,
  type SubscriptionPlan,
} from '../services/users'
import { authMiddleware, AuthRequest } from '../middleware/auth'
import { config } from '../config'

const router = Router()

// Auth: signup, login, profile

function parsePlan(value: unknown): SubscriptionPlan | undefined {
  if (value === 'starter' || value === 'pro') return value
  return undefined
}

router.post('/signup', async (req: Request, res: Response) => {
  const { email, password, plan: rawPlan } = req.body
  const plan = parsePlan(rawPlan)

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' })
  }

  if (isDemoMode()) {
    const user = getOrCreateDemoUser(email)
    const profile = await getUserProfile(user.id, user.email)
    if (plan) await updateUserProfile(user.id, user.email, { plan })
    return res.json({
      token: createDemoToken(user.id),
      user: plan ? await getUserProfile(user.id, user.email) : profile,
    })
  }

  const supabase = getSupabase()
  const { data, error } = await supabase.auth.signUp({ email, password })
  if (error) return res.status(400).json({ message: error.message })

  if (data.user) {
    try {
      await ensureUserRecords(data.user.id, data.user.email ?? email, plan)
    } catch (recordError) {
      console.error('Failed to initialize user records:', recordError)
    }
  }

  if (!data.session) {
    return res.status(201).json({
      needsEmailConfirmation: true,
      message: 'Check your email to confirm your account, then log in.',
    })
  }

  const profile = await getUserProfile(data.user!.id, data.user!.email ?? email)
  return res.json({
    token: data.session.access_token,
    user: profile,
  })
})

router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body
  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' })
  }

  if (isDemoMode()) {
    const user = getOrCreateDemoUser(email)
    const profile = await getUserProfile(user.id, user.email)
    return res.json({
      token: createDemoToken(user.id),
      user: profile,
    })
  }

  const supabase = getSupabase()
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) return res.status(401).json({ message: error.message })

  const profile = await getUserProfile(data.user.id, data.user.email ?? email)
  return res.json({
    token: data.session.access_token,
    user: profile,
  })
})

router.get('/me', authMiddleware, async (req: AuthRequest, res: Response) => {
  const profile = await getUserProfile(req.user!.id, req.user!.email)
  res.json(profile)
})

router.patch('/me', authMiddleware, async (req: AuthRequest, res: Response) => {
  const { displayName, defaultChain, plan: rawPlan } = req.body
  const plan = parsePlan(rawPlan)

  // SUBSCRIPTIONS DISABLED — with no paywall there is no checkout to route plan changes through,
  // so this guard only applies while the subscription layer is switched on.
  if (config.subscriptionsEnabled && plan && isStripeConfigured() && !isDemoMode()) {
    return res.status(400).json({
      message: 'Plan changes must be made through Stripe checkout. Visit the pricing page.',
    })
  }

  const profile = await updateUserProfile(req.user!.id, req.user!.email, {
    displayName,
    defaultChain,
    plan,
  })

  res.json(profile)
})

export default router
