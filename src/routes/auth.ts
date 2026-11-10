import { Router, Request, Response } from 'express'
import type { Session } from '@supabase/supabase-js'
import { createAuthClient } from '../services/supabase'
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
import { config, resolveFrontendUrl } from '../config'

const router = Router()

// Auth: signup, login, profile

/**
 * The access token lasts an hour. The refresh token lets the browser get a new one without
 * logging in again, so a session lasts until logout rather than until the first token expires.
 */
function sessionTokens(session: Session) {
  return {
    token: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: session.expires_at ?? null,
  }
}

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

  const { data, error } = await createAuthClient().auth.signUp({ email, password })
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
    ...sessionTokens(data.session),
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

  const { data, error } = await createAuthClient().auth.signInWithPassword({ email, password })
  if (error) return res.status(401).json({ message: error.message })

  const profile = await getUserProfile(data.user.id, data.user.email ?? email)
  return res.json({ ...sessionTokens(data.session), user: profile })
})

/**
 * Emails a password reset link that lands on the frontend's /reset-password page. Always answers
 * the same way, so the form can't be used to find out which emails have accounts.
 */
router.post('/forgot-password', async (req: Request, res: Response) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim() : ''
  if (!email) return res.status(400).json({ message: 'Email is required' })
  if (isDemoMode()) return res.status(400).json({ message: 'Demo mode has no passwords to reset' })

  const { error } = await createAuthClient().auth.resetPasswordForEmail(email, {
    // The site the request came from (when it's an allowed origin), else FRONTEND_URL.
    redirectTo: `${resolveFrontendUrl(req)}/reset-password`,
  })
  // Supabase's own rate limit is the one error worth showing; the rest would reveal nothing useful.
  if (error?.status === 429) {
    return res.status(429).json({ message: 'Too many reset requests. Wait a minute and try again.' })
  }
  if (error) console.warn('[auth] Password reset email failed:', error.message)
  return res.json({ message: 'If an account exists for that email, a reset link is on its way.' })
})

/** Sets a new password using the recovery session from the reset email's link. */
router.post('/reset-password', async (req: Request, res: Response) => {
  const { accessToken, refreshToken, password } = req.body
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string' || !accessToken || !refreshToken) {
    return res.status(400).json({ message: 'This reset link is invalid. Request a new one.' })
  }
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ message: 'Password must be at least 6 characters' })
  }
  if (isDemoMode()) return res.status(400).json({ message: 'Demo mode has no passwords to reset' })

  const client = createAuthClient()
  const { error: sessionError } = await client.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  })
  if (sessionError) {
    // 400, not 401: the frontend treats a 401 as its own stored session expiring.
    return res.status(400).json({ message: 'This reset link has expired. Request a new one.' })
  }
  const { error } = await client.auth.updateUser({ password })
  if (error) return res.status(400).json({ message: error.message })
  return res.json({ message: 'Password updated. Log in with your new password.' })
})

/** Exchanges a refresh token for a new access token. The refresh token is single-use. */
router.post('/refresh', async (req: Request, res: Response) => {
  const refreshToken = typeof req.body.refreshToken === 'string' ? req.body.refreshToken : ''
  if (!refreshToken) return res.status(400).json({ message: 'Refresh token is required' })
  if (isDemoMode()) return res.status(400).json({ message: 'Demo sessions do not expire' })

  const { data, error } = await createAuthClient().auth.refreshSession({ refresh_token: refreshToken })
  if (error || !data.session) {
    return res.status(401).json({ message: error?.message ?? 'Session expired, please log in again' })
  }
  return res.json(sessionTokens(data.session))
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
