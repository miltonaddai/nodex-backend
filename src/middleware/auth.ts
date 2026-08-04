import { Request, Response, NextFunction } from 'express'
import { getSupabase } from '../services/supabase'
import { isDemoMode, resolveDemoUserFromToken } from '../services/demo-auth'
import { TtlCache } from '../services/ttl-cache'

export interface AuthRequest extends Request {
  user?: { id: string; email: string }
}

type AuthUser = { id: string; email: string }

/**
 * Verifying the bearer token is a network round trip to Supabase, and the dashboard fires one
 * per page change / sort / filter. Cache the token -> user mapping briefly. The TTL is always
 * clamped to the token's own `exp`, so a cached entry can never outlive the token itself.
 */
const TOKEN_CACHE_TTL_MS = 60_000
const tokenCache = new TtlCache<AuthUser>(TOKEN_CACHE_TTL_MS)

/** Reads the `exp` claim without verifying — Supabase still does the real verification. */
function tokenExpiryMs(token: string): number | null {
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return typeof claims.exp === 'number' ? claims.exp * 1000 : null
  } catch {
    return null
  }
}

async function resolveUserFromToken(token: string): Promise<AuthUser | null> {
  const expiresAt = tokenExpiryMs(token)
  if (expiresAt !== null && Date.now() >= expiresAt) return null

  const cached = tokenCache.get(token)
  if (cached) return cached

  const { data, error } = await getSupabase().auth.getUser(token)
  if (error || !data.user) return null

  const user: AuthUser = { id: data.user.id, email: data.user.email ?? '' }
  // Never cache past the token's own expiry.
  if (expiresAt === null || Date.now() + TOKEN_CACHE_TTL_MS < expiresAt) {
    tokenCache.set(token, user)
  }
  return user
}

export async function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  const token = header.slice(7)

  if (isDemoMode()) {
    try {
      const user = resolveDemoUserFromToken(token)
      if (!user) return res.status(401).json({ message: 'Invalid token' })
      req.user = user
      return next()
    } catch {
      return res.status(401).json({ message: 'Invalid token' })
    }
  }

  const user = await resolveUserFromToken(token)
  if (!user) {
    return res.status(401).json({ message: 'Invalid token' })
  }
  req.user = user
  next()
}

export function optionalAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return next()

  const token = header.slice(7)

  if (isDemoMode()) {
    try {
      const user = resolveDemoUserFromToken(token)
      if (user) req.user = user
    } catch {
      // ignore invalid token in optional auth
    }
    return next()
  }

  resolveUserFromToken(token)
    .then((user) => {
      if (user) req.user = user
      next()
    })
    .catch(() => next())
}
