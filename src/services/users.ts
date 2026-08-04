export type SubscriptionPlan = 'starter' | 'pro'
export type SubscriptionStatus = 'active' | 'canceled' | 'past_due' | 'trialing'

export interface UserSubscription {
  plan: SubscriptionPlan
  status: SubscriptionStatus
  currentPeriodEnd: string | null
}

export interface UserProfile {
  id: string
  email: string
  displayName: string | null
  defaultChain: string
  subscription: UserSubscription
}

interface ProfileRow {
  id: string
  email: string
  display_name: string | null
  default_chain: string
}

interface SubscriptionRow {
  plan: SubscriptionPlan
  status: SubscriptionStatus
  current_period_end: string | null
}

const demoProfiles = new Map<string, UserProfile>()

function defaultSubscription(plan: SubscriptionPlan = 'starter'): UserSubscription {
  return { plan, status: 'active', currentPeriodEnd: null }
}

function inactiveSubscription(plan: SubscriptionPlan = 'starter'): UserSubscription {
  return { plan, status: 'canceled', currentPeriodEnd: null }
}

export function getDemoProfile(userId: string, email: string): UserProfile {
  const existing = demoProfiles.get(userId)
  if (existing) return existing

  const profile: UserProfile = {
    id: userId,
    email,
    displayName: null,
    defaultChain: 'solana',
    subscription: defaultSubscription(),
  }
  demoProfiles.set(userId, profile)
  return profile
}

export function updateDemoProfile(
  userId: string,
  email: string,
  updates: Partial<Pick<UserProfile, 'displayName' | 'defaultChain'>> & {
    plan?: SubscriptionPlan
  }
): UserProfile {
  const profile = getDemoProfile(userId, email)
  if (updates.displayName !== undefined) profile.displayName = updates.displayName
  if (updates.defaultChain !== undefined) profile.defaultChain = updates.defaultChain
  if (updates.plan) profile.subscription.plan = updates.plan
  demoProfiles.set(userId, profile)
  return profile
}

function mapProfile(profile: ProfileRow, subscription: SubscriptionRow | null): UserProfile {
  return {
    id: profile.id,
    email: profile.email,
    displayName: profile.display_name,
    defaultChain: profile.default_chain,
    subscription: subscription
      ? {
          plan: subscription.plan,
          status: subscription.status,
          currentPeriodEnd: subscription.current_period_end,
        }
      : inactiveSubscription(),
  }
}

export async function ensureUserRecords(
  userId: string,
  email: string,
  plan?: SubscriptionPlan
): Promise<void> {
  const { getSupabaseAdmin } = await import('./supabase')
  const { invalidateSubscriptionCache } = await import('./subscription-cache')
  const admin = getSupabaseAdmin()

  const { data: profile } = await admin.from('profiles').select('id').eq('id', userId).maybeSingle()

  if (!profile) {
    const { error: profileError } = await admin.from('profiles').insert({
      id: userId,
      email,
    })
    if (profileError) throw profileError
  }

  const { data: subscription } = await admin
    .from('subscriptions')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle()

  if (!subscription) {
    const { error: subError } = await admin.from('subscriptions').insert({
      user_id: userId,
      plan: plan ?? 'starter',
      status: 'canceled',
    })
    if (subError) throw subError
    invalidateSubscriptionCache(userId)
  } else if (plan) {
    const { error: updateError } = await admin
      .from('subscriptions')
      .update({ plan })
      .eq('user_id', userId)
    if (updateError) throw updateError
    invalidateSubscriptionCache(userId)
  }
}

export async function getUserProfile(userId: string, email: string): Promise<UserProfile> {
  const { isDemoMode } = await import('./demo-auth')
  if (isDemoMode()) return getDemoProfile(userId, email)

  const { getSupabaseAdmin } = await import('./supabase')
  const { resolveEntitledSubscription } = await import('./subscription-access')
  const admin = getSupabaseAdmin()

  await ensureUserRecords(userId, email)

  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('id, email, display_name, default_chain')
    .eq('id', userId)
    .single()

  if (profileError || !profile) throw profileError ?? new Error('Profile not found')

  const subscription = await resolveEntitledSubscription(userId)

  return {
    id: profile.id,
    email: profile.email,
    displayName: profile.display_name,
    defaultChain: profile.default_chain,
    subscription,
  }
}

export async function updateUserProfile(
  userId: string,
  email: string,
  updates: {
    displayName?: string | null
    defaultChain?: string
    plan?: SubscriptionPlan
  }
): Promise<UserProfile> {
  const { isDemoMode } = await import('./demo-auth')
  if (isDemoMode()) {
    return updateDemoProfile(userId, email, updates)
  }

  const { getSupabaseAdmin } = await import('./supabase')
  const { invalidateSubscriptionCache } = await import('./subscription-cache')
  const admin = getSupabaseAdmin()

  if (updates.displayName !== undefined || updates.defaultChain !== undefined) {
    const patch: Record<string, string | null> = {}
    if (updates.displayName !== undefined) patch.display_name = updates.displayName
    if (updates.defaultChain !== undefined) patch.default_chain = updates.defaultChain

    const { error } = await admin.from('profiles').update(patch).eq('id', userId)
    if (error) throw error
  }

  if (updates.plan) {
    await ensureUserRecords(userId, email)
    const { error } = await admin.from('subscriptions').update({ plan: updates.plan }).eq('user_id', userId)
    if (error) throw error
    invalidateSubscriptionCache(userId)
  }

  return getUserProfile(userId, email)
}
