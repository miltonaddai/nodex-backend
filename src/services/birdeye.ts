import { config } from '../config'
import { throttleBirdeye } from './rate-limit'
import type { PeriodConfig } from '../lib/periods'
import { PERIOD_CONFIG } from '../lib/periods'

export interface TokenData {
  address: string
  name: string
  symbol: string
  imageUrl: string
  price: number
  marketCap: number
  volume24h: number
  priceChange7d: number
  holders: number
  liquidity: number
  priceChange24h: number
  priceChange30d: number
  v24hChangePercent: number
  listedAt: number
}

export interface TraderGainerRow {
  address: string
  pnl: number
  realizedPnl: number
  unrealizedPnl: number
  volume: number
  trades: number
  winRate: number
}

export interface WalletPnlSummary {
  realizedProfitUsd: number
  unrealizedUsd: number
  totalUsd: number
  winRate: number
  totalTrades: number
  currentValue: number
  totalInvested: number
  uniqueTokens: number
}

export interface WalletPortfolio {
  totalValueUsd: number
  tokensHeld: number
}

export interface TokenTopTrader {
  tokenAddress: string
  owner: string
  tags: string[]
  trades: number
  tradeBuy: number
  tradeSell: number
  volumeBuy: number
  volumeSell: number
  volumeBuyUsd: number
  volumeSellUsd: number
  volumeUsd: number
  totalPnl: number
  realizedPnl: number
  unrealizedPnl: number
  holdVolume: number
  holdVolumeUsd: number
  firstTradeUnixTime: number
  lastTradeUnixTime: number
  fundingUnixTime: number
  netWorth: number
  solBalance: number
}

async function birdeyeFetch(path: string, chain = 'solana', retries = 1): Promise<unknown | null> {
  if (!config.birdeye.apiKey) return null

  for (let attempt = 0; attempt <= retries; attempt++) {
    await throttleBirdeye()

    const res = await fetch(`${config.birdeye.baseUrl}${path}`, {
      headers: {
        'X-API-KEY': config.birdeye.apiKey,
        'x-chain': chain,
      },
      signal: AbortSignal.timeout(config.worker.providerRequestTimeoutMs),
    })

    if (res.status === 429 && attempt < retries) {
      const backoffMs = 5000 * 2 ** attempt
      console.warn(`Birdeye rate limited, retrying in ${backoffMs}ms: ${path}`)
      await sleep(backoffMs)
      continue
    }

    if (!res.ok) {
      console.warn(`Birdeye API error ${res.status} for ${path}`)
      return null
    }

    return res.json()
  }

  return null
}

export async function getTokenTopTraders(
  address: string,
  chain: string,
  timeFrame: '24h' | '7d' | '30d',
  limit = 10
): Promise<TokenTopTrader[]> {
  const params = new URLSearchParams({
    address,
    time_frame: timeFrame,
    sort_by: 'total_pnl',
    sort_type: 'desc',
    offset: '0',
    limit: String(Math.min(Math.max(limit, 1), 10)),
    get_holders_networth: 'true',
    ui_amount_mode: 'scaled',
  })
  const json = (await birdeyeFetch(
    `/defi/v2/tokens/top_traders?${params}`,
    chain === 'solana' ? 'solana' : 'ethereum'
  )) as { data?: { items?: Record<string, unknown>[] } } | null

  return (json?.data?.items ?? []).map((row) => {
    const funding =
      row.funding && typeof row.funding === 'object'
        ? (row.funding as Record<string, unknown>)
        : {}
    return {
      tokenAddress: str(row.tokenAddress ?? address),
      owner: str(row.owner),
      tags: Array.isArray(row.tags)
        ? row.tags.filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.toLowerCase())
        : [],
      trades: num(row.trade),
      tradeBuy: num(row.tradeBuy),
      tradeSell: num(row.tradeSell),
      volumeBuy: num(row.volumeBuy),
      volumeSell: num(row.volumeSell),
      volumeBuyUsd: num(row.volumeBuyUSD),
      volumeSellUsd: num(row.volumeSellUSD),
      volumeUsd: num(row.volumeUsd),
      totalPnl: num(row.totalPnl),
      realizedPnl: num(row.realizedPnl),
      unrealizedPnl: num(row.unrealizedPnl),
      holdVolume: num(row.holdVolume),
      holdVolumeUsd: num(row.holdVolumeUsd),
      firstTradeUnixTime: unixSeconds(row.firstTradeUnixTime),
      lastTradeUnixTime: unixSeconds(row.lastTradeUnixTime),
      fundingUnixTime: unixSeconds(funding.unixTime ?? funding.unix_time),
      netWorth: num(row.netWorth ?? row.net_worth),
      solBalance: num(row.solBalance ?? row.sol_balance),
    }
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function unixSeconds(value: unknown): number {
  const timestamp = num(value)
  return timestamp > 10_000_000_000 ? Math.floor(timestamp / 1000) : Math.floor(timestamp)
}

function tokenImageUrl(value: Record<string, unknown>): string {
  return str(value.logo_uri ?? value.logoURI ?? value.logo ?? value.image_url ?? value.image)
}

function mapTokenRow(t: Record<string, unknown>): TokenData {
  return {
    address: str(t.address),
    name: str(t.name, 'Unknown'),
    symbol: str(t.symbol, '???'),
    imageUrl: tokenImageUrl(t),
    price: num(t.price),
    marketCap: num(t.mc ?? t.market_cap),
    volume24h: num(t.v24hUSD ?? t.volume24hUSD ?? t.volume_24h_usd),
    priceChange7d: num(t.priceChange7dPercent ?? t.price_change_7d_percent),
    holders: num(t.holder ?? t.holders ?? t.holder_count),
    liquidity: num(t.liquidity),
    priceChange24h: num(t.priceChange24hPercent ?? t.v24hChangePercent ?? t.price_change_24h_percent),
    priceChange30d: num(t.priceChange30dPercent ?? t.price_change_30d_percent),
    v24hChangePercent: num(
      t.v24hChangePercent ?? t.priceChange24hPercent ?? t.price_change_24h_percent ?? t.volume_24h_change_percent
    ),
    listedAt: unixSeconds(
      t.recent_listing_time ??
        t.recentListingTime ??
        t.listing_time ??
        t.listed_at ??
        t.creation_time ??
        t.created_at
    ),
  }
}

export interface RecentTokenOptions {
  maxAgeDays: number
  limit: number
  pageSize: number
  minLiquidity: number
  minVolume: number
  minHolders: number
  maxMarketCap: number
}

/** Discover recently listed tokens without falling back to generic market-cap leaders. */
export async function getRecentlyListedTokens(chain: string, opts: RecentTokenOptions): Promise<TokenData[]> {
  const chainHeader = chain === 'solana' ? 'solana' : 'ethereum'
  const listedAfter = Math.floor(Date.now() / 1000) - opts.maxAgeDays * 86_400
  const pageSize = Math.min(Math.max(opts.pageSize, 1), 100)
  const result = new Map<string, TokenData>()

  for (let offset = 0; offset < opts.limit; offset += pageSize) {
    const params = new URLSearchParams({
      sort_by: 'recent_listing_time',
      sort_type: 'desc',
      limit: String(Math.min(pageSize, opts.limit - offset)),
      offset: String(offset),
      min_recent_listing_time: String(listedAfter),
      min_liquidity: String(opts.minLiquidity),
      min_volume_24h_usd: String(opts.minVolume),
      min_holder: String(opts.minHolders),
    })
    const json = (await birdeyeFetch(`/defi/v3/token/list?${params}`, chainHeader)) as {
      data?: { items?: Record<string, unknown>[]; tokens?: Record<string, unknown>[] }
    } | null
    const items = json?.data?.items ?? json?.data?.tokens ?? []
    if (items.length === 0) break

    for (const raw of items) {
      const token = mapTokenRow(raw)
      if (!token.address || token.listedAt < listedAfter) continue
      if (opts.maxMarketCap > 0 && token.marketCap > opts.maxMarketCap) continue
      result.set(token.address, token)
    }
    if (items.length < pageSize || result.size >= opts.limit) break
  }

  return [...result.values()].slice(0, opts.limit)
}

export interface DiscoveredToken extends TokenData {
  fdv: number
  uniqueWallet24h: number
  tradeCount24h: number
  buyCount24h: number
  sellCount24h: number
  /** unique_wallet_24h / holder. See config.worker.discoveryMinChurn for why this matters. */
  churn: number
  buySellRatio: number
}

function mapDiscoveredToken(raw: Record<string, unknown>): DiscoveredToken {
  const base = mapTokenRow(raw)
  const holders = num(raw.holder ?? raw.holders)
  const uniqueWallet24h = num(raw.unique_wallet_24h)
  const buyCount24h = num(raw.buy_24h)
  const sellCount24h = num(raw.sell_24h)
  return {
    ...base,
    holders,
    fdv: num(raw.fdv),
    uniqueWallet24h,
    tradeCount24h: num(raw.trade_24h_count),
    buyCount24h,
    sellCount24h,
    churn: holders > 0 ? uniqueWallet24h / holders : 0,
    buySellRatio: sellCount24h > 0 ? buyCount24h / sellCount24h : buyCount24h > 0 ? Infinity : 0,
  }
}

export interface DiscoveryOptions {
  minChurn: number
  maxChurn: number
  minHolders: number
  minLiquidity: number
  minTrades24h: number
  minVolume24h: number
  minFdv: number
  maxFdv: number
  maxBuySellRatio: number
  minAgeHours: number
  maxAgeDays: number
  pages: number
}

async function getTokenImageUrls(addresses: string[], chain: string): Promise<Map<string, string>> {
  const images = new Map<string, string>()
  const chainHeader = chain === 'solana' ? 'solana' : 'ethereum'

  for (let offset = 0; offset < addresses.length; offset += 50) {
    const batch = addresses.slice(offset, offset + 50)
    const params = new URLSearchParams({ list_address: batch.join(',') })
    const json = (await birdeyeFetch(
      `/defi/v3/token/meta-data/multiple?${params}`,
      chainHeader
    )) as { data?: unknown } | null
    const data = json?.data
    if (!data || typeof data !== 'object') continue

    const container = data as Record<string, unknown>
    const listedRows = Array.isArray(data)
      ? data.map((value) => ['', value] as const)
      : Array.isArray(container.items)
        ? container.items.map((value) => ['', value] as const)
        : Array.isArray(container.tokens)
          ? container.tokens.map((value) => ['', value] as const)
          : Object.entries(container)

    for (const [key, value] of listedRows) {
      if (!value || typeof value !== 'object') continue
      const row = value as Record<string, unknown>
      const address = str(row.address ?? row.token_address ?? row.tokenAddress, key)
      const imageUrl = tokenImageUrl(row)
      if (address && imageUrl) images.set(address, imageUrl)
    }
  }

  return images
}

/**
 * Discovers tokens with an organic trading shape.
 *
 * Structural filters (liquidity, holders, trade count, listing window) are deliberately loose —
 * they exist only to exclude the unmeasurable. The real screen is churn, which separates farms
 * and bundles from organic tokens and, unlike volume or holder count, cannot be faked by simply
 * spending more: a farm has to choose between its wallets holding and its wallets trading.
 *
 * Birdeye permits at most 5 filter params per request, so those five slots go server-side and
 * everything else is evaluated from the response body.
 */
export async function discoverQualityTokens(
  chain: string,
  opts: DiscoveryOptions
): Promise<DiscoveredToken[]> {
  const chainHeader = chain === 'solana' ? 'solana' : 'ethereum'
  const now = Math.floor(Date.now() / 1000)
  const found = new Map<string, DiscoveredToken>()

  // Two sort orders so we do not only sample the most-traded slice, where farms concentrate.
  for (const sortBy of ['trade_24h_count', 'holder']) {
    for (let page = 0; page < opts.pages; page++) {
      const params = new URLSearchParams({
        sort_by: sortBy,
        sort_type: 'desc',
        limit: '100',
        offset: String(page * 100),
        min_recent_listing_time: String(now - opts.maxAgeDays * 86_400),
        max_recent_listing_time: String(now - opts.minAgeHours * 3600),
        min_liquidity: String(opts.minLiquidity),
        min_holder: String(opts.minHolders),
        min_trade_24h_count: String(opts.minTrades24h),
      })

      const json = (await birdeyeFetch(`/defi/v3/token/list?${params}`, chainHeader)) as {
        data?: { items?: Record<string, unknown>[] }
      } | null
      const items = json?.data?.items ?? []
      for (const raw of items) {
        const token = mapDiscoveredToken(raw)
        if (token.address) found.set(token.address, token)
      }
      if (items.length < 100) break
    }
  }

  const qualified = [...found.values()]
    .filter(
      (t) =>
        t.fdv >= opts.minFdv &&
        t.fdv <= opts.maxFdv &&
        t.volume24h >= opts.minVolume24h &&
        t.churn >= opts.minChurn &&
        t.churn <= opts.maxChurn &&
        t.buySellRatio <= opts.maxBuySellRatio
    )
    .sort((a, b) => b.churn - a.churn)

  const missingImages = qualified.filter((token) => !token.imageUrl).map((token) => token.address)
  const imageUrls = await getTokenImageUrls(missingImages, chain)
  return qualified.map((token) => ({
    ...token,
    imageUrl: token.imageUrl || imageUrls.get(token.address) || '',
  }))
}

export function pickTokenPeriodFields(token: TokenData, period: PeriodConfig) {
  const raw = token as unknown as Record<string, unknown>
  const changePct = num(raw[period.tokenChangeField] ?? token.v24hChangePercent ?? token.priceChange24h)
  const volume = num(raw[period.tokenVolumeField] ?? token.volume24h)
  return { changePct, volume }
}

export async function getTopTokensFiltered(
  chain: string,
  opts: { limit: number; minLiquidity: number; minVolume: number; minHolders: number }
): Promise<TokenData[]> {
  const chainHeader = chain === 'solana' ? 'solana' : 'ethereum'
  const limit = Math.min(Math.max(opts.limit, 1), 100)
  const params = new URLSearchParams({
    sort_by: 'volume_24h_usd',
    sort_type: 'desc',
    limit: String(limit),
    offset: '0',
    min_liquidity: String(opts.minLiquidity),
    min_volume_24h_usd: String(opts.minVolume),
    min_holder: String(opts.minHolders),
  })

  const json = (await birdeyeFetch(`/defi/v3/token/list?${params}`, chainHeader)) as {
    data?: { items?: Record<string, unknown>[]; tokens?: Record<string, unknown>[] }
  } | null

  const items = json?.data?.items ?? json?.data?.tokens ?? []
  if (items.length > 0) return items.map((t) => mapTokenRow(t))

  return getTopTokensForPeriod(chain, PERIOD_CONFIG['7D'], limit)
}

export async function getTopTokensForPeriod(
  chain: string,
  period: PeriodConfig,
  limit: number
): Promise<TokenData[]> {
  const json = (await birdeyeFetch(
    `/defi/tokenlist?sort_by=${encodeURIComponent(period.tokenSortBy)}&sort_type=desc&offset=0&limit=${limit}`,
    chain === 'solana' ? 'solana' : 'ethereum'
  )) as { data?: { tokens?: Record<string, unknown>[] } } | null

  if (!json?.data?.tokens) return []
  return json.data.tokens.map((t) => mapTokenRow(t))
}

export async function getTraderGainersLosers(
  chain: string,
  period: PeriodConfig,
  limit: number
): Promise<TraderGainerRow[]> {
  const json = (await birdeyeFetch(
    `/trader/gainers-losers?type=${encodeURIComponent(period.birdeyeWalletType)}&sort_by=realized_pnl&sort_type=desc&offset=0&limit=${limit}`,
    chain === 'solana' ? 'solana' : 'ethereum'
  )) as { data?: { items?: Record<string, unknown>[]; traders?: Record<string, unknown>[] } } | null

  const items = json?.data?.items ?? json?.data?.traders ?? []
  return items.map((row) => ({
    address: str(row.address ?? row.owner ?? row.wallet),
    pnl: num(row.pnl ?? row.PnL),
    realizedPnl: num(row.realized_pnl ?? row.realizedPnl ?? row.pnl ?? row.PnL),
    unrealizedPnl: num(row.unrealized_pnl ?? row.unrealizedPnl),
    volume: num(row.volume ?? row.trade_volume ?? row.v24hUSD),
    trades: num(row.trade_count ?? row.trades ?? row.tx_count),
    winRate: num(row.win_rate ?? row.winRate),
  }))
}

export async function getWalletPnlSummary(
  wallet: string,
  duration: PeriodConfig['birdeyePnlDuration']
): Promise<WalletPnlSummary | null> {
  const json = (await birdeyeFetch(
    `/wallet/v2/pnl/summary?wallet=${encodeURIComponent(wallet)}&duration=${encodeURIComponent(duration)}`
  )) as {
    data?: {
      unique_tokens?: number
      counts?: {
        total_trade?: number
        win_rate?: number
      }
      cashflow_usd?: {
        total_invested?: number
        current_value?: number
      }
      pnl?: {
        realized_profit_usd?: number
        unrealized_usd?: number
        total_usd?: number
      }
    }
  } | null

  if (!json?.data) return null

  const counts = json.data.counts ?? {}
  const cashflow = json.data.cashflow_usd ?? {}
  const pnl = json.data.pnl ?? {}

  return {
    realizedProfitUsd: num(pnl.realized_profit_usd),
    unrealizedUsd: num(pnl.unrealized_usd),
    totalUsd: num(pnl.total_usd),
    winRate: num(counts.win_rate),
    totalTrades: num(counts.total_trade),
    currentValue: num(cashflow.current_value),
    totalInvested: num(cashflow.total_invested),
    uniqueTokens: num(json.data.unique_tokens),
  }
}

/** Portfolio value and token count; excludes low-liquidity positions below minHoldingValue. */
export async function getWalletPortfolio(
  wallet: string,
  minHoldingValue = 100
): Promise<WalletPortfolio | null> {
  const json = (await birdeyeFetch(
    `/wallet/v2/current-net-worth?wallet=${encodeURIComponent(wallet)}&sort_type=desc&limit=1&filter_value=${minHoldingValue}`
  )) as {
    data?: { total_value?: string | number }
    pagination?: { total?: number }
  } | null

  if (!json?.data) return null
  const totalValueUsd = Number(json.data.total_value)
  if (!Number.isFinite(totalValueUsd)) return null

  return {
    totalValueUsd,
    tokensHeld: num(json.pagination?.total),
  }
}

/** @deprecated Use getWalletPortfolio */
export async function getWalletNetWorthUsd(wallet: string, minHoldingValue = 100): Promise<number | null> {
  const portfolio = await getWalletPortfolio(wallet, minHoldingValue)
  return portfolio?.totalValueUsd ?? null
}

export async function getTopTokens(chain: string, limit = 10): Promise<TokenData[]> {
  const json = (await birdeyeFetch(
    `/defi/tokenlist?sort_by=mc&sort_type=desc&offset=0&limit=${limit}`,
    chain === 'solana' ? 'solana' : 'ethereum'
  )) as { data?: { tokens?: Record<string, unknown>[] } } | null

  if (!json?.data?.tokens) return []
  return json.data.tokens.map((t) => mapTokenRow(t))
}

export async function getTokenOverview(address: string, chain: string): Promise<TokenData | null> {
  const json = (await birdeyeFetch(`/defi/token_overview?address=${address}`, chain === 'solana' ? 'solana' : 'ethereum')) as {
    data?: Record<string, unknown>
  } | null

  if (!json?.data) return null
  return mapTokenRow(json.data)
}

export interface PricePoint {
  unixTime: number
  value: number
}

/** Price history for a token between two unix times. `interval` is a Birdeye type like 15m or 1H. */
export async function getPriceHistory(
  address: string,
  chain: string,
  interval: '15m' | '1H' | '4H',
  timeFrom: number,
  timeTo: number
): Promise<PricePoint[]> {
  const params = new URLSearchParams({
    address,
    address_type: 'token',
    type: interval,
    time_from: String(Math.floor(timeFrom)),
    time_to: String(Math.floor(timeTo)),
  })
  const json = (await birdeyeFetch(`/defi/history_price?${params}`, chain === 'solana' ? 'solana' : 'ethereum')) as {
    data?: { items?: Array<{ unixTime?: number; value?: number }> }
  } | null
  return (json?.data?.items ?? [])
    .map((item) => ({ unixTime: Number(item.unixTime ?? 0), value: Number(item.value ?? 0) }))
    .filter((point) => point.unixTime > 0 && point.value > 0)
}

export interface LeaderboardTrader {
  address: string
  pnl: number
  realizedPnl: number
  unrealizedPnl: number
  volume: number
  trades: number
}

/** One page of Birdeye's trader profit leaderboard. `type` is a window like 30d. */
export async function getProfitLeaderboardPage(
  type: 'today' | '1W' | '30d' | '90d',
  offset: number,
  limit = 50
): Promise<LeaderboardTrader[]> {
  const params = new URLSearchParams({
    type,
    sort_by: 'PnL',
    sort_type: 'desc',
    offset: String(offset),
    limit: String(Math.min(Math.max(limit, 1), 50)),
  })
  const json = (await birdeyeFetch(`/trader/gainers-losers?${params}`)) as {
    data?: { items?: Record<string, unknown>[] }
  } | null
  return (json?.data?.items ?? []).map((row) => ({
    address: str(row.address),
    pnl: num(row.pnl),
    realizedPnl: num(row.realized_pnl),
    unrealizedPnl: num(row.unrealized_pnl),
    volume: num(row.volume),
    trades: num(row.trade_count),
  }))
}

export interface WalletSwapSide {
  address: string
  symbol: string
  /** Signed change for the wallet: positive means it received the token. */
  uiChangeAmount: number
}

export interface WalletSwap {
  txHash: string
  /** Instruction position, so several swaps in one transaction stay distinct. */
  insIndex: number
  innerInsIndex: number
  blockTime: number
  volumeUsd: number
  base: WalletSwapSide
  quote: WalletSwapSide
}

function swapSide(raw: unknown): WalletSwapSide {
  const side = (raw ?? {}) as Record<string, unknown>
  return {
    address: str(side.address),
    symbol: str(side.symbol),
    uiChangeAmount: num(side.ui_change_amount),
  }
}

/** A wallet's swaps since `afterTime` (unix seconds), newest first. */
export async function getWalletSwapsSince(wallet: string, afterTime: number, maxPages = 2): Promise<WalletSwap[]> {
  // Newest first. Stops at the first short page or after maxPages.
  const swaps: WalletSwap[] = []
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      address: wallet,
      offset: String(page * 100),
      limit: '100',
      tx_type: 'swap',
      after_time: String(Math.floor(afterTime)),
    })
    const json = (await birdeyeFetch(`/trader/txs/seek_by_time?${params}`)) as {
      data?: { items?: Record<string, unknown>[]; has_next?: boolean }
    } | null
    for (const row of json?.data?.items ?? []) {
      swaps.push({
        txHash: str(row.tx_hash),
        insIndex: num(row.ins_index),
        innerInsIndex: num(row.inner_ins_index),
        blockTime: num(row.block_unix_time),
        volumeUsd: num(row.volume_usd),
        base: swapSide(row.base),
        quote: swapSide(row.quote),
      })
    }
    if (!json?.data?.has_next) break
  }
  return swaps
}
