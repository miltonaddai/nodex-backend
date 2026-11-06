import { randomBytes } from 'node:crypto'
import { isDemoMode } from './demo-auth'
import { getSupabaseAdmin } from './supabase'

/**
 * Telegram links (user ↔ chat), the single-use codes that create them, and the record of which
 * tokens each alert has already sent. Demo accounts keep all of this in memory.
 */

export interface TelegramLink {
  userId: string
  chatId: number
  username: string | null
  earlySignals: boolean
  linkedAt: string
}

const CODE_TTL_MS = 10 * 60 * 1000

const demo = {
  links: new Map<string, TelegramLink>(),
  codes: new Map<string, { userId: string; expiresAt: number }>(),
  delivered: new Map<string, Set<string>>(),
}

interface LinkRow {
  user_id: string
  chat_id: number | string
  username: string | null
  early_signals: boolean
  linked_at: string
}

const toLink = (row: LinkRow): TelegramLink => ({
  userId: row.user_id,
  chatId: Number(row.chat_id),
  username: row.username,
  earlySignals: row.early_signals !== false,
  linkedAt: row.linked_at,
})

/* ---------- Link codes ---------- */

/** A new single-use code for the "Connect Telegram" link. Replaces the user's earlier codes. */
export async function createLinkCode(userId: string): Promise<{ code: string; expiresAt: string }> {
  const code = randomBytes(16).toString('hex')
  const expiresAt = Date.now() + CODE_TTL_MS
  if (isDemoMode()) {
    for (const [key, value] of demo.codes) if (value.userId === userId) demo.codes.delete(key)
    demo.codes.set(code, { userId, expiresAt })
  } else {
    const admin = getSupabaseAdmin()
    await admin.from('telegram_link_codes').delete().eq('user_id', userId)
    const { error } = await admin
      .from('telegram_link_codes')
      .insert({ code, user_id: userId, expires_at: new Date(expiresAt).toISOString() })
    if (error) throw error
  }
  return { code, expiresAt: new Date(expiresAt).toISOString() }
}

/** The user a code belongs to, if it is real and unexpired. The code is used up either way. */
export async function consumeLinkCode(code: string): Promise<string | null> {
  if (!/^[a-f0-9]{32}$/.test(code)) return null
  if (isDemoMode()) {
    const entry = demo.codes.get(code)
    demo.codes.delete(code)
    return entry && entry.expiresAt > Date.now() ? entry.userId : null
  }
  const admin = getSupabaseAdmin()
  const { data, error } = await admin.from('telegram_link_codes').select('user_id, expires_at').eq('code', code).maybeSingle()
  if (error) throw error
  await admin.from('telegram_link_codes').delete().eq('code', code)
  if (!data || Date.parse(data.expires_at) <= Date.now()) return null
  return data.user_id as string
}

/* ---------- Links ---------- */

export async function getLink(userId: string): Promise<TelegramLink | null> {
  if (isDemoMode()) return demo.links.get(userId) ?? null
  const { data, error } = await getSupabaseAdmin()
    .from('telegram_links')
    .select('user_id, chat_id, username, early_signals, linked_at')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  return data ? toLink(data as LinkRow) : null
}

export async function getLinkByChat(chatId: number): Promise<TelegramLink | null> {
  if (isDemoMode()) return [...demo.links.values()].find((link) => link.chatId === chatId) ?? null
  const { data, error } = await getSupabaseAdmin()
    .from('telegram_links')
    .select('user_id, chat_id, username, early_signals, linked_at')
    .eq('chat_id', chatId)
    .maybeSingle()
  if (error) throw error
  return data ? toLink(data as LinkRow) : null
}

export async function listLinks(): Promise<TelegramLink[]> {
  if (isDemoMode()) return [...demo.links.values()]
  const { data, error } = await getSupabaseAdmin().from('telegram_links').select('user_id, chat_id, username, early_signals, linked_at')
  if (error) throw error
  return (data ?? []).map((row) => toLink(row as LinkRow))
}

/** Links a chat to a user. A chat belongs to one account, so any earlier owner of it is unlinked. */
export async function linkChat(userId: string, chatId: number, username: string | null): Promise<TelegramLink> {
  const link: TelegramLink = { userId, chatId, username, earlySignals: true, linkedAt: new Date().toISOString() }
  if (isDemoMode()) {
    for (const [key, value] of demo.links) if (value.chatId === chatId) demo.links.delete(key)
    const existing = demo.links.get(userId)
    demo.links.set(userId, { ...link, earlySignals: existing?.earlySignals ?? true })
    return demo.links.get(userId)!
  }
  const admin = getSupabaseAdmin()
  await admin.from('telegram_links').delete().eq('chat_id', chatId).neq('user_id', userId)
  const { data, error } = await admin
    .from('telegram_links')
    .upsert({ user_id: userId, chat_id: chatId, username, linked_at: link.linkedAt }, { onConflict: 'user_id' })
    .select('user_id, chat_id, username, early_signals, linked_at')
    .single()
  if (error) throw error
  return toLink(data as LinkRow)
}

export async function unlinkUser(userId: string): Promise<void> {
  if (isDemoMode()) {
    demo.links.delete(userId)
    return
  }
  const { error } = await getSupabaseAdmin().from('telegram_links').delete().eq('user_id', userId)
  if (error) throw error
}

export async function unlinkChat(chatId: number): Promise<void> {
  if (isDemoMode()) {
    for (const [key, value] of demo.links) if (value.chatId === chatId) demo.links.delete(key)
    return
  }
  const { error } = await getSupabaseAdmin().from('telegram_links').delete().eq('chat_id', chatId)
  if (error) throw error
}

export async function setEarlySignals(userId: string, earlySignals: boolean): Promise<TelegramLink | null> {
  if (isDemoMode()) {
    const link = demo.links.get(userId)
    if (link) link.earlySignals = earlySignals
    return link ?? null
  }
  const { data, error } = await getSupabaseAdmin()
    .from('telegram_links')
    .update({ early_signals: earlySignals })
    .eq('user_id', userId)
    .select('user_id, chat_id, username, early_signals, linked_at')
    .maybeSingle()
  if (error) throw error
  return data ? toLink(data as LinkRow) : null
}

/* ---------- Deliveries ---------- */

/** Marks an alert and chain as started; its first check records matches without sending them. */
export const STARTED = '*'

const deliveryKey = (userId: string, alertKey: string, chain: string) => `${userId}|${alertKey}|${chain}`

/** Contracts this alert has already handled on this chain (including the STARTED marker). */
export async function getDelivered(userId: string, alertKey: string, chain: string): Promise<Set<string>> {
  if (isDemoMode()) return new Set(demo.delivered.get(deliveryKey(userId, alertKey, chain)) ?? [])
  const { data, error } = await getSupabaseAdmin()
    .from('alert_deliveries')
    .select('contract')
    .eq('user_id', userId)
    .eq('alert_key', alertKey)
    .eq('chain', chain)
  if (error) throw error
  return new Set((data ?? []).map((row) => row.contract as string))
}

export async function recordDelivered(userId: string, alertKey: string, chain: string, contracts: string[]): Promise<void> {
  if (contracts.length === 0) return
  if (isDemoMode()) {
    const key = deliveryKey(userId, alertKey, chain)
    const set = demo.delivered.get(key) ?? new Set<string>()
    for (const contract of contracts) set.add(contract)
    demo.delivered.set(key, set)
    return
  }
  const { error } = await getSupabaseAdmin()
    .from('alert_deliveries')
    .upsert(
      contracts.map((contract) => ({ user_id: userId, alert_key: alertKey, chain, contract })),
      { onConflict: 'user_id,alert_key,chain,contract', ignoreDuplicates: true }
    )
  if (error) throw error
}

/** Drops delivery records older than `days`, keeping the started markers. */
export async function pruneDeliveries(days: number): Promise<void> {
  if (isDemoMode()) return
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString()
  const { error } = await getSupabaseAdmin().from('alert_deliveries').delete().lt('sent_at', cutoff).neq('contract', STARTED)
  if (error) throw error
}
