import { randomUUID } from 'crypto'
import type { WatchlistWallet } from '../data/mock'
import { demoSeededChains, demoWatchlist, getMockWatchlist } from '../data/mock'
import { isDemoMode } from './demo-auth'
import { isClickhouseConfigured, queryClickhouse } from './clickhouse'

interface WatchlistRow {
  id: string
  user_id: string
  name: string
  address: string
  chain: string
  created_at: string
}

interface WalletAnalyticsRow {
  address: string
  balance: number
  total_profit: number
  win_rate: number
  last_active: string
}

function formatLastActive(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value || 'recently'
  const minutes = Math.max(1, Math.floor((Date.now() - date.getTime()) / 60_000))
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

// Returns null when analytics could not be consulted at all (ClickHouse unconfigured or
// erroring). That is different from an empty map, which means we asked and the wallets
// genuinely have no rows — only the latter justifies telling the user there is no data.
async function getAnalytics(
  addresses: string[],
  chain: string
): Promise<Map<string, WalletAnalyticsRow> | null> {
  if (addresses.length === 0) return new Map()
  if (!isClickhouseConfigured()) return null
  try {
    const rows = await queryClickhouse<WalletAnalyticsRow>(
      `SELECT address, balance, total_profit, win_rate, last_active
       FROM wallet_analytics FINAL
       WHERE chain = {chain:String}
         AND period_days = 7
         AND address IN {addresses:Array(String)}`,
      { chain, addresses }
    )
    return new Map(rows.map((row) => [row.address, row]))
  } catch (error) {
    console.warn('Failed to enrich watchlist from wallet analytics:', error)
    return null
  }
}

function applyAnalytics(wallet: WatchlistWallet, analytics?: WalletAnalyticsRow): WatchlistWallet {
  if (!analytics) return wallet
  return {
    ...wallet,
    balance: Number(analytics.balance) || 0,
    pnl7d: Number(analytics.total_profit) || 0,
    winRate: Number(analytics.win_rate) || 0,
    lastActive: formatLastActive(analytics.last_active),
  }
}

// Demo mode starts from the mock watchlist, but edits have to stick: once a user has
// renamed or removed anything on a chain, that chain's list becomes authoritative and
// the mocks are never re-served (not even when the list is emptied).
function seedDemoWatchlist(userId: string, chain: string): WatchlistWallet[] {
  const list = demoWatchlist.get(userId) ?? []
  if (!demoSeededChains.has(`${userId}:${chain}`)) {
    if (!list.some((wallet) => wallet.chain === chain)) {
      list.push(...getMockWatchlist(chain).map((wallet) => ({ ...wallet })))
    }
    demoSeededChains.add(`${userId}:${chain}`)
    demoWatchlist.set(userId, list)
  }
  return list
}

export async function listWatchlist(userId: string | undefined, chain: string): Promise<WatchlistWallet[]> {
  if (!userId || isDemoMode()) {
    if (userId) {
      const filtered = (demoWatchlist.get(userId) ?? []).filter((w) => w.chain === chain)
      if (filtered.length > 0 || demoSeededChains.has(`${userId}:${chain}`)) {
        const analytics = await getAnalytics(filtered.map((wallet) => wallet.address), chain)
        // Demo wallets carry synthetic metrics, so a missing row is never "no data" here.
        return filtered.map((wallet) => applyAnalytics(wallet, analytics?.get(wallet.address)))
      }
    }
    return getMockWatchlist(chain)
  }

  const { getSupabaseAdmin } = await import('./supabase')
  const admin = getSupabaseAdmin()

  const { data, error } = await admin
    .from('watchlist_wallets')
    .select('id, user_id, name, address, chain, created_at')
    .eq('user_id', userId)
    .eq('chain', chain)
    .order('created_at', { ascending: true })

  if (error) throw error
  // Mock wallets belong exclusively to demo mode. Returning them for an empty
  // persisted watchlist exposes synthetic ids such as "wl-1" to clients; those
  // ids cannot be used against this table's UUID primary key.
  if (!data?.length) return []

  const rows = data as WatchlistRow[]
  const analytics = await getAnalytics(rows.map((row) => row.address), chain)

  // The watchlist is owned by Supabase, so a wallet stays listed even when its analytics
  // have been wiped from ClickHouse. Flag those so the UI shows "no data" instead of
  // presenting the placeholder zeros below as real measurements.
  return rows.map((row) =>
    applyAnalytics(
      {
        id: row.id,
        name: row.name,
        address: row.address,
        chain: row.chain,
        balance: 0,
        pnl7d: 0,
        winRate: 0,
        lastActive: 'recently',
        analyticsUnavailable: analytics ? !analytics.has(row.address) : true,
      },
      analytics?.get(row.address)
    )
  )
}

export async function addWatchlistWallet(
  userId: string,
  input: { name: string; address: string; chain: string; balance: number }
): Promise<WatchlistWallet> {
  if (isDemoMode()) {
    const wallet: WatchlistWallet = {
      id: randomUUID(),
      name: input.name,
      address: input.address,
      chain: input.chain,
      balance: input.balance,
      pnl7d: 0,
      winRate: 0,
      lastActive: 'just now',
    }
    const list = demoWatchlist.get(userId) || []
    list.push(wallet)
    demoWatchlist.set(userId, list)
    const analytics = await getAnalytics([wallet.address], wallet.chain)
    return applyAnalytics(wallet, analytics?.get(wallet.address))
  }

  const { getSupabaseAdmin } = await import('./supabase')
  const admin = getSupabaseAdmin()

  const { data, error } = await admin
    .from('watchlist_wallets')
    .insert({
      user_id: userId,
      name: input.name,
      address: input.address,
      chain: input.chain,
    })
    .select('id, user_id, name, address, chain, created_at')
    .single()

  if (error) throw error

  const analytics = await getAnalytics([data.address], data.chain)
  const wallet = {
    id: data.id,
    name: data.name,
    address: data.address,
    chain: data.chain,
    balance: input.balance,
    pnl7d: 0,
    winRate: 0,
    lastActive: 'just now',
    analyticsUnavailable: analytics ? !analytics.has(data.address) : true,
  }
  return applyAnalytics(wallet, analytics?.get(wallet.address))
}

export async function renameWatchlistWallet(
  userId: string,
  walletId: string,
  name: string,
  chain: string
): Promise<{ id: string; name: string }> {
  if (isDemoMode()) {
    const list = seedDemoWatchlist(userId, chain)
    const wallet = list.find((item) => item.id === walletId)
    if (!wallet) throw new Error('Watchlist wallet not found')
    wallet.name = name
    demoWatchlist.set(userId, list)
    return { id: wallet.id, name: wallet.name }
  }

  const { getSupabaseAdmin } = await import('./supabase')
  const admin = getSupabaseAdmin()
  const { data, error } = await admin
    .from('watchlist_wallets')
    .update({ name })
    .eq('id', walletId)
    .eq('user_id', userId)
    .select('id, name')
    .single()

  if (error) throw error
  return { id: data.id, name: data.name }
}

export async function removeWatchlistWallet(
  userId: string,
  walletId: string,
  chain: string
): Promise<void> {
  if (isDemoMode()) {
    const list = seedDemoWatchlist(userId, chain)
    demoWatchlist.set(
      userId,
      list.filter((w) => w.id !== walletId)
    )
    return
  }

  const { getSupabaseAdmin } = await import('./supabase')
  const admin = getSupabaseAdmin()

  const { error } = await admin
    .from('watchlist_wallets')
    .delete()
    .eq('id', walletId)
    .eq('user_id', userId)

  if (error) throw error
}
