import { isDemoMode } from './demo-auth'
import { getSupabaseAdmin } from './supabase'
import { sanitizeRules, type FilterRule } from '../lib/custom-filters'

/** A user's saved custom filter for the Smart Wallets table. Alerts are separate (alerts-store). */
export interface SavedFilter {
  id: string
  name: string
  rules: FilterRule[]
}

export const MAX_SAVED_FILTERS = 20
export const MAX_FILTER_NAME = 32

/** Demo accounts keep their filters in memory, like the demo watchlists. */
const demoFilters = new Map<string, SavedFilter[]>()

interface Row {
  id: string
  name: string
  rules: unknown
}

const COLUMNS = 'id, name, rules'

const toFilter = (row: Row): SavedFilter => ({ id: row.id, name: row.name, rules: sanitizeRules(row.rules) })

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

/**
 * Saves a filter. A filter with the same name (any case) is replaced, so "Save" on an existing
 * name updates it rather than duplicating it.
 */
export async function saveFilter(userId: string, name: string, rawRules: unknown): Promise<SavedFilter> {
  const trimmed = name.trim().slice(0, MAX_FILTER_NAME)
  const rules = sanitizeRules(rawRules)
  if (!trimmed) throw new SavedFilterError('Give the filter a name')
  if (rules.length === 0) throw new SavedFilterError('Add at least one condition')

  const existing = await listSavedFilters(userId)
  const replacing = existing.find((filter) => filter.name.toLowerCase() === trimmed.toLowerCase())
  if (!replacing && existing.length >= MAX_SAVED_FILTERS) {
    throw new SavedFilterError(`You can save up to ${MAX_SAVED_FILTERS} filters. Delete one first.`)
  }

  if (isDemoMode()) {
    const saved: SavedFilter = { id: replacing?.id ?? `demo-${Date.now()}`, name: trimmed, rules }
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
    .insert({ user_id: userId, name: trimmed, rules })
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
