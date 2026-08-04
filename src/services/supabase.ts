import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { config } from '../config'

let supabase: SupabaseClient | null = null
let supabaseAdmin: SupabaseClient | null = null

export function getSupabase(): SupabaseClient {
  if (!supabase) {
    if (!config.supabase.url || !config.supabase.anonKey) {
      throw new Error('Supabase credentials not configured')
    }
    supabase = createClient(config.supabase.url, config.supabase.anonKey)
  }
  return supabase
}

export function getSupabaseAdmin(): SupabaseClient {
  if (!supabaseAdmin) {
    if (!config.supabase.url || !config.supabase.serviceRoleKey) {
      throw new Error('Supabase service role key not configured')
    }
    supabaseAdmin = createClient(config.supabase.url, config.supabase.serviceRoleKey)
  }
  return supabaseAdmin
}

export function isSupabaseConfigured(): boolean {
  return Boolean(config.supabase.url && config.supabase.anonKey)
}
