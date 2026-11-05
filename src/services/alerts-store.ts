import { isDemoMode } from './demo-auth'
import { getSupabaseAdmin } from './supabase'
import { sanitizeRules, type FilterRule } from '../lib/custom-filters'

/**
 * A user's alert: conditions on the Smart Wallets data, watched in the background on the chosen
 * chains. Separate from saved filters, which only shape the table on screen. Uses the same rule
 * format and checker as the table filter (lib/custom-filters).
 */
export interface Alert {
  id: string
  name: string
  rules: FilterRule[]
  chains: string[]
  enabled: boolean
}

export const MAX_ALERTS = 25
/** Each switched-on alert is checked on every chain it covers, so the number is kept modest. */
export const MAX_ENABLED_ALERTS = 10
export const MAX_ALERT_NAME = 40

const CHAINS = ['solana', 'robinhood', 'bsc']

export class AlertError extends Error {}

const demoAlerts = new Map<string, Alert[]>()

interface Row {
  id: string
  name: string
  rules: unknown
  chains: string[] | null
  enabled: boolean | null
}

const COLUMNS = 'id, name, rules, chains, enabled'

function cleanChains(value: unknown): string[] {
  const chains = Array.isArray(value) ? CHAINS.filter((chain) => value.includes(chain)) : []
  return chains.length ? chains : [...CHAINS]
}

const toAlert = (row: Row): Alert => ({
  id: row.id,
  name: row.name,
  rules: sanitizeRules(row.rules),
  chains: cleanChains(row.chains),
  enabled: row.enabled !== false,
})

export async function listAlerts(userId: string): Promise<Alert[]> {
  if (isDemoMode()) return demoAlerts.get(userId) ?? []
  const { data, error } = await getSupabaseAdmin()
    .from('alerts')
    .select(COLUMNS)
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data ?? []).map((row) => toAlert(row as Row))
}

/** Checks and cleans a full or partial alert from a request body. */
function clean(input: Record<string, unknown>, current?: Alert) {
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, MAX_ALERT_NAME) : (current?.name ?? '')
  const rules = input.rules !== undefined ? sanitizeRules(input.rules) : (current?.rules ?? [])
  const chains = input.chains !== undefined ? cleanChains(input.chains) : (current?.chains ?? [...CHAINS])
  const enabled = typeof input.enabled === 'boolean' ? input.enabled : (current?.enabled ?? true)
  if (!name) throw new AlertError('Give the alert a name')
  if (rules.length === 0) throw new AlertError('Add at least one condition')
  return { name, rules, chains, enabled }
}

function checkEnabledLimit(existing: Alert[], exceptId?: string) {
  if (existing.filter((alert) => alert.enabled && alert.id !== exceptId).length >= MAX_ENABLED_ALERTS) {
    throw new AlertError(`You can have up to ${MAX_ENABLED_ALERTS} alerts on at once. Switch one off first.`)
  }
}

export async function createAlert(userId: string, input: Record<string, unknown>): Promise<Alert> {
  const existing = await listAlerts(userId)
  if (existing.length >= MAX_ALERTS) throw new AlertError(`You can have up to ${MAX_ALERTS} alerts. Delete one first.`)
  const fields = clean(input)
  if (fields.enabled) checkEnabledLimit(existing)

  if (isDemoMode()) {
    const alert: Alert = { id: `demo-${Date.now()}`, ...fields }
    demoAlerts.set(userId, [...existing, alert])
    return alert
  }
  const { data, error } = await getSupabaseAdmin()
    .from('alerts')
    .insert({ user_id: userId, ...fields })
    .select(COLUMNS)
    .single()
  if (error) throw error
  return toAlert(data as Row)
}

/** Changes any of name, rules, chains or enabled. */
export async function updateAlert(userId: string, id: string, input: Record<string, unknown>): Promise<Alert> {
  const existing = await listAlerts(userId)
  const current = existing.find((alert) => alert.id === id)
  if (!current) throw new AlertError('That alert no longer exists')
  const fields = clean(input, current)
  if (fields.enabled && !current.enabled) checkEnabledLimit(existing, id)

  if (isDemoMode()) {
    const updated = { ...current, ...fields }
    demoAlerts.set(userId, existing.map((alert) => (alert.id === id ? updated : alert)))
    return updated
  }
  const { data, error } = await getSupabaseAdmin()
    .from('alerts')
    .update(fields)
    .eq('user_id', userId)
    .eq('id', id)
    .select(COLUMNS)
    .single()
  if (error) throw error
  return toAlert(data as Row)
}

export async function deleteAlert(userId: string, id: string): Promise<void> {
  if (isDemoMode()) {
    demoAlerts.set(userId, (demoAlerts.get(userId) ?? []).filter((alert) => alert.id !== id))
    return
  }
  const { error } = await getSupabaseAdmin().from('alerts').delete().eq('user_id', userId).eq('id', id)
  if (error) throw error
}
