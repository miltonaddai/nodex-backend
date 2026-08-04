import { Response, NextFunction } from 'express'
import { AuthRequest } from './auth'
import { config } from '../config'
import { isUserSubscriptionEntitled } from '../services/subscription-access'

export async function subscriptionMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  if (!req.user) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  // SUBSCRIPTIONS DISABLED — personal-use deployment. Authentication still applies (the check
  // above stands); only the paywall is bypassed. Set SUBSCRIPTIONS_ENABLED=true to restore it.
  if (!config.subscriptionsEnabled) {
    return next()
  }

  try {
    const entitled = await isUserSubscriptionEntitled(req.user.id)
    if (!entitled) {
      return res.status(403).json({
        message: 'Active subscription required. Please select a plan to continue.',
        code: 'SUBSCRIPTION_REQUIRED',
      })
    }
    next()
  } catch (error) {
    console.error('Subscription check failed:', error)
    res.status(500).json({ message: 'Unable to verify subscription' })
  }
}
