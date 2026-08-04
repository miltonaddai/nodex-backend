import { randomUUID } from 'crypto'
import { getMockTopTokens } from '../data/mock'
import { isDemoMode } from './demo-auth'
import { isClickhouseConfigured, queryClickhouse } from './clickhouse'

export interface WatchlistToken {
  id: string
  contract: string
  name: string
  symbol: string
  chain: string
  price: number
  marketCap: number
  changePct: number
  volume: number
  liquidity: number
  churn: number
  launchedAt?: string
  ageDays?: number
  /** No token_analytics row backs this token — the metrics above are placeholders. */
  analyticsUnavailable?: boolean
}

interface TokenWatchlistRow {
  id: string
  user_id: string
  contract: string
  name: string
  symbol: string
  chain: string
  created_at: string
}

interface TokenAnalyticsRow {
  contract: string
  price: number
  market_cap: number
  change_pct: number
  volume: number
  liquidity: number
  churn: number
  launched_at: string
  age_days: number
}

// Demo watchlists live in memory per demo user, starting empty; tokens are added
// from the (mock-backed) tokens table and enriched from the same mock rows.
const demoTokenWatchlist = new Map<string, WatchlistToken[]>()

function emptyMetrics(row: Pick<TokenWatchlistRow, 'id' | 'contract' | 'name' | 'symbol' | 'chain'>): WatchlistToken {
  return {
    id: row.id,
    contract: row.contract,
    name: row.name,
    symbol: row.symbol,
    chain: row.chain,
    price: 0,
    marketCap: 0,
    changePct: 0,
    volume: 0,
    liquidity: 0,
    churn: 0,
    analyticsUnavailable: true,
  }
}

// Same contract as the wallet watchlist: null means analytics could not be consulted
// at all, an empty map means we asked and the tokens genuinely have no rows.
async function getTokenAnalytics(
  contracts: string[],
  chain: string
): Promise<Map<string, TokenAnalyticsRow> | null> {
  if (contracts.length === 0) return new Map()
  if (!isClickhouseConfigured()) return null
  try {
    const rows = await queryClickhouse<TokenAnalyticsRow>(
      `SELECT contract, price, market_cap, change_pct, volume, liquidity, churn, launched_at, age_days
       FROM token_analytics FINAL
       WHERE chain = {chain:String}
         AND period_days = 7
         AND contract IN {contracts:Array(String)}`,
      { chain, contracts }
    )
    return new Map(rows.map((row) => [row.contract, row]))
  } catch (error) {
    console.warn('Failed to enrich token watchlist from token analytics:', error)
    return null
  }
}

function applyAnalytics(token: WatchlistToken, analytics?: TokenAnalyticsRow): WatchlistToken {
  if (!analytics) return token
  return {
    ...token,
    price: Number(analytics.price) || 0,
    marketCap: Number(analytics.market_cap) || 0,
    changePct: Number(analytics.change_pct) || 0,
    volume: Number(analytics.volume) || 0,
    liquidity: Number(analytics.liquidity) || 0,
    churn: Number(analytics.churn) || 0,
    launchedAt: analytics.launched_at,
    ageDays: Number(analytics.age_days) || 0,
    analyticsUnavailable: false,
  }
}

function applyMockMetrics(token: WatchlistToken): WatchlistToken {
  const mock = getMockTopTokens(token.chain, '7D').find((row) => row.contract === token.contract)
  if (!mock) return token
  return {
    ...token,
    price: mock.price,
    marketCap: mock.marketCap,
    changePct: mock.changePct,
    volume: mock.volume,
    liquidity: mock.liquidity ?? 0,
    churn: mock.churn ?? 0,
    launchedAt: mock.launchedAt,
    ageDays: mock.ageDays,
    analyticsUnavailable: false,
  }
}

async function enrich(tokens: WatchlistToken[], chain: string): Promise<WatchlistToken[]> {
  if (isDemoMode()) return tokens.map(applyMockMetrics)
  const analytics = await getTokenAnalytics(tokens.map((token) => token.contract), chain)
  return tokens.map((token) => {
    if (!analytics) return { ...token, analyticsUnavailable: true }
    return applyAnalytics(
      { ...token, analyticsUnavailable: !analytics.has(token.contract) },
      analytics.get(token.contract)
    )
  })
}

export async function listWatchlistTokens(userId: string, chain: string): Promise<WatchlistToken[]> {
  if (isDemoMode()) {
    const list = (demoTokenWatchlist.get(userId) ?? []).filter((token) => token.chain === chain)
    return enrich(list, chain)
  }

  const { getSupabaseAdmin } = await import('./supabase')
  const admin = getSupabaseAdmin()

  const { data, error } = await admin
    .from('watchlist_tokens')
    .select('id, user_id, contract, name, symbol, chain, created_at')
    .eq('user_id', userId)
    .eq('chain', chain)
    .order('created_at', { ascending: true })

  if (error) throw error
  return enrich((data as TokenWatchlistRow[]).map(emptyMetrics), chain)
}

export async function addWatchlistToken(
  userId: string,
  input: { contract: string; name: string; symbol: string; chain: string }
): Promise<WatchlistToken> {
  if (isDemoMode()) {
    const list = demoTokenWatchlist.get(userId) ?? []
    const existing = list.find(
      (token) => token.contract === input.contract && token.chain === input.chain
    )
    if (existing) return applyMockMetrics(existing)
    const token = emptyMetrics({ id: randomUUID(), ...input })
    list.push(token)
    demoTokenWatchlist.set(userId, list)
    return applyMockMetrics(token)
  }

  const { getSupabaseAdmin } = await import('./supabase')
  const admin = getSupabaseAdmin()

  const { data, error } = await admin
    .from('watchlist_tokens')
    .upsert(
      {
        user_id: userId,
        contract: input.contract,
        name: input.name,
        symbol: input.symbol,
        chain: input.chain,
      },
      { onConflict: 'user_id,contract,chain' }
    )
    .select('id, user_id, contract, name, symbol, chain, created_at')
    .single()

  if (error) throw error

  const [token] = await enrich([emptyMetrics(data as TokenWatchlistRow)], input.chain)
  return token
}

export async function removeWatchlistToken(
  userId: string,
  tokenId: string,
  chain: string
): Promise<void> {
  if (isDemoMode()) {
    const list = demoTokenWatchlist.get(userId) ?? []
    demoTokenWatchlist.set(
      userId,
      list.filter((token) => !(token.id === tokenId && token.chain === chain))
    )
    return
  }

  const { getSupabaseAdmin } = await import('./supabase')
  const admin = getSupabaseAdmin()

  const { error } = await admin
    .from('watchlist_tokens')
    .delete()
    .eq('id', tokenId)
    .eq('user_id', userId)

  if (error) throw error
}
