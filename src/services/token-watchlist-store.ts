import { randomUUID } from 'crypto'
import { getMockTopTokens } from '../data/mock'
import { isDemoMode } from './demo-auth'
import { isClickhouseConfigured, queryClickhouse } from './clickhouse'
import { getTokenQuotes, type TokenQuote } from './dexscreener'
import { getTokenImage } from './helius'
import { cacheGet, cacheSet } from './redis'

export interface WatchlistToken {
  id: string
  contract: string
  name: string
  symbol: string
  imageUrl?: string
  chain: string
  price: number
  marketCap: number
  changePct: number
  volume: number
  liquidity: number
  churn: number
  launchedAt?: string
  ageDays?: number
  /** No live market data was found for this token — the metrics above are placeholders. */
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
  image_url: string
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
      `SELECT contract, image_url, price, market_cap, change_pct, volume, liquidity, churn, launched_at, age_days
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
    imageUrl: analytics.image_url || undefined,
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
    imageUrl: mock.imageUrl,
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

/** Live quotes are reused briefly so repeat visits do not re-hit Dexscreener. */
const QUOTE_TTL_SECONDS = 60

async function liveQuotes(contracts: string[], chain: string): Promise<Map<string, TokenQuote>> {
  if (contracts.length === 0) return new Map()
  const key = `watchlist:quotes:v1:${chain}:${[...contracts].sort().join(',')}`
  const cached = await cacheGet<Array<[string, TokenQuote]>>(key)
  if (cached) return new Map(cached)
  try {
    const quotes = await getTokenQuotes(chain, contracts)
    // Dexscreener has no image for some tokens. On Solana the token's own metadata usually does.
    if (chain === 'solana') {
      for (const [contract, quote] of quotes) {
        if (!quote.imageUrl) quote.imageUrl = (await getTokenImage(contract).catch(() => null)) ?? ''
      }
    }
    await cacheSet(key, [...quotes.entries()], QUOTE_TTL_SECONDS)
    return quotes
  } catch (error) {
    console.warn('Failed to load live quotes for token watchlist:', error)
    return new Map()
  }
}

/**
 * Live market data for every tracked token, whichever page it was added from. Discovery's
 * token_analytics only covers tokens that passed the churn screen, and its change figure is
 * the 7-day change from when discovery last saw the token, so it only supplies churn and age.
 */
async function enrich(tokens: WatchlistToken[], chain: string): Promise<WatchlistToken[]> {
  if (isDemoMode()) return tokens.map(applyMockMetrics)
  const contracts = tokens.map((token) => token.contract)
  const [analytics, quotes] = await Promise.all([getTokenAnalytics(contracts, chain), liveQuotes(contracts, chain)])
  return tokens.map((token) => {
    const discovered = applyAnalytics(token, analytics?.get(token.contract))
    const quote = quotes.get(token.contract)
    if (!quote) return { ...discovered, analyticsUnavailable: !analytics?.has(token.contract) }
    const ageDays =
      discovered.ageDays ?? (quote.firstPoolAt ? Math.floor((Date.now() - quote.firstPoolAt) / 86_400_000) : undefined)
    return {
      ...discovered,
      imageUrl: quote.imageUrl || discovered.imageUrl,
      price: quote.price,
      marketCap: quote.marketCap,
      changePct: quote.priceChange24h,
      volume: quote.volume24h,
      liquidity: quote.liquidity,
      ageDays,
      analyticsUnavailable: false,
    }
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

  // No enrich here: it can wait on an idle ClickHouse waking up plus Dexscreener and Helius,
  // which made adding feel stuck. The watchlist page loads live metrics when it lists tokens.
  return emptyMetrics(data as TokenWatchlistRow)
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
