import { randomUUID } from 'crypto'
import { config } from '../config'
import { demoUsers } from '../data/mock'

export function isDemoMode(): boolean {
  const flag = process.env.DEMO_MODE
  if (flag === 'true') return true
  if (flag === 'false') return false
  return !Boolean(config.supabase.url && config.supabase.anonKey)
}

export function createDemoToken(userId: string): string {
  return Buffer.from(userId).toString('base64')
}

export function getOrCreateDemoUser(email: string) {
  const normalized = email.trim()
  const existing = [...demoUsers.values()].find(
    (user) => user.email.toLowerCase() === normalized.toLowerCase()
  )
  if (existing) return existing

  const user = { id: randomUUID(), email: normalized, password: '' }
  demoUsers.set(user.id, user)
  return user
}

export function resolveDemoUserFromToken(token: string) {
  const decoded = Buffer.from(token, 'base64').toString('utf-8')

  if (decoded.startsWith('demo:')) {
    const email = decoded.slice(5)
    return { id: decoded, email }
  }

  const user = [...demoUsers.values()].find((entry) => entry.id === decoded)
  if (!user) return null

  return { id: user.id, email: user.email }
}
