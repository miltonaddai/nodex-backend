import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { config } from '../config'

let supabase: SupabaseClient | null = null
let supabaseAdmin: SupabaseClient | null = null

/**
 * Server-side clients must never hold a user session. A shared client that signs users in keeps
 * the last session and auto-refreshes it in the background, spending the same single-use refresh
 * token the browser holds. Supabase treats that reuse as theft and revokes the session.
 */
const STATELESS_AUTH = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }

export function getSupabase(): SupabaseClient {
  if (!supabase) {
    if (!config.supabase.url || !config.supabase.anonKey) {
      throw new Error('Supabase credentials not configured')
    }
    supabase = createClient(config.supabase.url, config.supabase.anonKey, { auth: STATELESS_AUTH })
  }
  return supabase
}

/** A throwaway client for sign-in, sign-up and refresh, so no session outlives the request. */
export function createAuthClient(): SupabaseClient {
  if (!config.supabase.url || !config.supabase.anonKey) {
    throw new Error('Supabase credentials not configured')
  }
  return createClient(config.supabase.url, config.supabase.anonKey, { auth: STATELESS_AUTH })
}

export function getSupabaseAdmin(): SupabaseClient {
  if (!supabaseAdmin) {
    if (!config.supabase.url || !config.supabase.serviceRoleKey) {
      throw new Error('Supabase service role key not configured')
    }
    supabaseAdmin = createClient(config.supabase.url, config.supabase.serviceRoleKey, { auth: STATELESS_AUTH })
  }
  return supabaseAdmin
}

export function isSupabaseConfigured(): boolean {
  return Boolean(config.supabase.url && config.supabase.anonKey)
}
