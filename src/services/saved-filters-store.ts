import { isDemoMode } from './demo-auth'
import { getSupabaseAdmin } from './supabase'
import { sanitizeRules, type FilterRule } from '../lib/custom-filters'

/** A user's saved custom filter for the Smart Wallets table, and its alert settings. */
export interface SavedFilter {
  id: string
  name: string
  rules: FilterRule[]
  /** Alert when a token newly matches. The browser checks while WhaleMo is open. */
  alert: boolean
  alertChains: string[]
}

export const MAX_SAVED_FILTERS = 20
export const MAX_FILTER_NAME = 32
/** Each alert is polled by the browser on every chain it covers, so the number is kept modest. */
export const MAX_ALERTS = 10

const CHAINS = ['solana', 'robinhood', 'bsc']
const ALL_CHAINS = [...CHAINS]

/** Demo accounts keep their filters in memory, like the demo watchlists. */
const demoFilters = new Map<string, SavedFilter[]>()

interface Row {
  id: string
  name: string
  rules: unknown
  alert: boolean | null
  alert_chains: string[] | null
}

const COLUMNS = 'id, name, rules, alert, alert_chains'

function cleanChains(value: unknown): string[] {
  const chains = Array.isArray(value) ? CHAINS.filter((chain) => value.includes(chain)) : []
  return chains.length ? chains : ALL_CHAINS
}

const toFilter = (row: Row): SavedFilter => ({
  id: row.id,
  name: row.name,
  rules: sanitizeRules(row.rules),
  alert: row.alert === true,
  alertChains: cleanChains(row.alert_chains),
})

export class SavedFilterError extends Error {}

export async function listSavedFilters(userId: string): Promise<SavedFilter[]> {
  if (isDemoMode()) return demoFilters.get(userId) ?? []
  const { data, error } = await getSupabaseAdmin()
    .from('saved_filters')
    .select(COLUMNS)
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data ?? []).map((row) => toFilter(row as Row))
}

function checkAlertLimit(existing: SavedFilter[], exceptId: string | undefined) {
  const others = existing.filter((filter) => filter.alert && filter.id !== exceptId).length
  if (others >= MAX_ALERTS) {
    throw new SavedFilterError(`You can have up to ${MAX_ALERTS} alerts on. Turn one off first.`)
  }
}

/**
 * Saves a filter. A filter with the same name (any case) is replaced, so "Save" on an existing
 * name updates it rather than duplicating it. Its alert settings carry over unless given.
 */
export async function saveFilter(
  userId: string,
  name: string,
  rawRules: unknown,
  options: { alert?: unknown; alertChains?: unknown } = {}
): Promise<SavedFilter> {
  const trimmed = name.trim().slice(0, MAX_FILTER_NAME)
  const rules = sanitizeRules(rawRules)
  if (!trimmed) throw new SavedFilterError('Give the filter a name')
  if (rules.length === 0) throw new SavedFilterError('Add at least one condition')

  const existing = await listSavedFilters(userId)
  const replacing = existing.find((filter) => filter.name.toLowerCase() === trimmed.toLowerCase())
  if (!replacing && existing.length >= MAX_SAVED_FILTERS) {
    throw new SavedFilterError(`You can save up to ${MAX_SAVED_FILTERS} filters. Delete one first.`)
  }
  const alert = typeof options.alert === 'boolean' ? options.alert : (replacing?.alert ?? false)
  const alertChains = options.alertChains !== undefined ? cleanChains(options.alertChains) : (replacing?.alertChains ?? ALL_CHAINS)
  if (alert) checkAlertLimit(existing, replacing?.id)

  if (isDemoMode()) {
    const saved: SavedFilter = { id: replacing?.id ?? `demo-${Date.now()}`, name: trimmed, rules, alert, alertChains }
    demoFilters.set(userId, [...existing.filter((filter) => filter.id !== replacing?.id), saved])
    return saved
  }

  const admin = getSupabaseAdmin()
  if (replacing) {
    const { error } = await admin.from('saved_filters').delete().eq('user_id', userId).eq('id', replacing.id)
    if (error) throw error
  }
  const { data, error } = await admin
    .from('saved_filters')
    .insert({ user_id: userId, name: trimmed, rules, alert, alert_chains: alertChains })
    .select(COLUMNS)
    .single()
  if (error) throw error
  return toFilter(data as Row)
}

/** Turns a filter's alert on or off, or changes the chains it watches. */
export async function updateFilterAlert(
  userId: string,
  id: string,
  changes: { alert?: unknown; alertChains?: unknown }
): Promise<SavedFilter> {
  const existing = await listSavedFilters(userId)
  const current = existing.find((filter) => filter.id === id)
  if (!current) throw new SavedFilterError('That filter no longer exists')
  const alert = typeof changes.alert === 'boolean' ? changes.alert : current.alert
  const alertChains = changes.alertChains !== undefined ? cleanChains(changes.alertChains) : current.alertChains
  if (alert && !current.alert) checkAlertLimit(existing, id)

  if (isDemoMode()) {
    const updated = { ...current, alert, alertChains }
    demoFilters.set(userId, existing.map((filter) => (filter.id === id ? updated : filter)))
    return updated
  }

  const { data, error } = await getSupabaseAdmin()
    .from('saved_filters')
    .update({ alert, alert_chains: alertChains })
    .eq('user_id', userId)
    .eq('id', id)
    .select(COLUMNS)
    .single()
  if (error) throw error
  return toFilter(data as Row)
}

export async function deleteSavedFilter(userId: string, id: string): Promise<void> {
  if (isDemoMode()) {
    demoFilters.set(userId, (demoFilters.get(userId) ?? []).filter((filter) => filter.id !== id))
    return
  }
  const { error } = await getSupabaseAdmin().from('saved_filters').delete().eq('user_id', userId).eq('id', id)
  if (error) throw error
}
