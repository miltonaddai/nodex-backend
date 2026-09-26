import { Router, Request, Response } from 'express'
import { getMockTopWallets } from '../data/mock'
import { isValidPeriod, periodToDays } from '../lib/periods'
import { PaginatedResult, parseNumericFilters, parsePagination, parseSortOrder, pickSortColumn } from '../lib/pagination'
import { isValidSolanaAddress } from '../lib/validation'
import { authMiddleware } from '../middleware/auth'
import { subscriptionMiddleware } from '../middleware/subscription'
import {
  countClickhouseRows,
  getNextScheduledUpdate,
  getSnapshotLastUpdated,
  isClickhouseConfigured,
  queryClickhouse,
  queryClickhousePaginated,
} from '../services/clickhouse'
import { cacheGet, cacheSet } from '../services/redis'
import { isDemoMode } from '../services/demo-auth'

const router = Router()

const WALLET_SORT_MAP = {
  qualifiedTokens: 'qualified_tokens',
  qualifiedProfit: 'qualified_profit_usd',
  smartScore: 'smart_score',
  totalProfit: 'total_profit',
  balance: 'balance',
  winRate: 'win_rate',
  trades: 'trades',
  volume: 'volume',
  tokensHeld: 'tokens_held',
  lastActive: 'last_active',
} as const

const WALLET_FILTER_KEYS = [
  'minBalance',
  'maxBalance',
  'minTotalProfit',
  'maxTotalProfit',
  'minWinRate',
  'maxWinRate',
  'minTrades',
  'maxTrades',
  'minTokensHeld',
  'maxTokensHeld',
  'minVolume',
  'maxVolume',
  'minQualifiedTokens',
  'maxQualifiedTokens',
  'minQualifiedWins',
  'maxQualifiedWins',
  'minQualifiedProfit',
  'maxQualifiedProfit',
  'activeWithinDays',
] as const

const WALLET_FILTER_FIELDS: Record<(typeof WALLET_FILTER_KEYS)[number], string> = {
  minBalance: 'balance',
  maxBalance: 'balance',
  minTotalProfit: 'totalProfit',
  maxTotalProfit: 'totalProfit',
  minWinRate: 'winRate',
  maxWinRate: 'winRate',
  minTrades: 'trades',
  maxTrades: 'trades',
  minTokensHeld: 'tokensHeld',
  maxTokensHeld: 'tokensHeld',
  minVolume: 'volume',
  maxVolume: 'volume',
  minQualifiedTokens: 'qualifiedTokens',
  maxQualifiedTokens: 'qualifiedTokens',
  minQualifiedWins: 'qualifiedWins',
  maxQualifiedWins: 'qualifiedWins',
  minQualifiedProfit: 'qualifiedProfitUsd',
  maxQualifiedProfit: 'qualifiedProfitUsd',
  activeWithinDays: 'lastActive',
}

function relativeAgeDays(value: unknown): number {
  const text = String(value ?? '')
  const match = text.match(/^(\d+)([mhd]) ago$/)
  if (match) {
    const amount = Number(match[1])
    return match[2] === 'd' ? amount : match[2] === 'h' ? amount / 24 : amount / 1_440
  }
  const timestamp = Date.parse(text)
  return Number.isFinite(timestamp) ? Math.max(0, (Date.now() - timestamp) / 86_400_000) : Infinity
}

function matchesWalletFilters(row: Record<string, unknown>, filters: Record<string, number>): boolean {
  return Object.entries(filters).every(([key, limit]) => {
    const field = WALLET_FILTER_FIELDS[key as keyof typeof WALLET_FILTER_FIELDS]
    if (!field) return true
    if (key === 'activeWithinDays') return relativeAgeDays(row[field]) <= limit
    const value = Number(row[field]) || 0
    return key.startsWith('min') ? value >= limit : value <= limit
  })
}

interface ClickhouseWallet {
  address: string
  balance: number
  total_profit: number
  win_rate: number
  trades: number
  volume: number
  tokens_held: number
  last_active: string
  smart_score: number
  qualified_tokens: number
  qualified_wins: number
  qualified_profit_usd: number
  qualified_win_rate: number
  young_token_trades: number
  young_token_wins: number
  median_roi_pct: number
  avg_entry_delay_minutes: number
  realized_profit: number
  unrealized_profit: number
  concentration_pct: number
  risk_flags: string[]
}

interface ClickhouseWalletPeriod extends ClickhouseWallet {
  period_days: number
  updated_at: string
}

interface ClickhouseWalletPosition {
  contract: string
  launched_at: string
  first_buy_at: string
  last_trade_at: string
  entry_delay_minutes: number
  buy_usd: number
  sell_usd: number
  bought_amount: number
  sold_amount: number
  remaining_amount: number
  realized_pnl: number
  unrealized_pnl: number
  roi_pct: number
  trade_count: number
  suspicious_trade_count: number
  name: string
  symbol: string
  current_price: number
  market_cap: number
  liquidity: number
  alpha_score: number
}

function formatLastActive(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const diffMs = Date.now() - date.getTime()
  const mins = Math.floor(diffMs / 60000)
  if (mins < 60) return `${Math.max(1, mins)}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function mapWalletRow(row: ClickhouseWallet, rank: number) {
  return {
    rank,
    address: row.address,
    balance: row.balance,
    totalProfit: row.total_profit,
    winRate: row.win_rate,
    trades: row.trades,
    volume: row.volume,
    tokensHeld: Number(row.tokens_held) || 0,
    lastActive: formatLastActive(row.last_active),
    smartScore: Number(row.smart_score) || 0,
    qualifiedTokens: Number(row.qualified_tokens) || 0,
    qualifiedWins: Number(row.qualified_wins) || 0,
    qualifiedProfitUsd: Number(row.qualified_profit_usd) || 0,
    qualifiedWinRate: Number(row.qualified_win_rate) || 0,
    youngTokenTrades: Number(row.young_token_trades) || 0,
    youngTokenWins: Number(row.young_token_wins) || 0,
    medianRoiPct: Number(row.median_roi_pct) || 0,
    avgEntryDelayMinutes: Number(row.avg_entry_delay_minutes) || 0,
    realizedProfit: Number(row.realized_profit) || 0,
    unrealizedProfit: Number(row.unrealized_profit) || 0,
    concentrationPct: Number(row.concentration_pct) || 0,
    riskFlags: row.risk_flags ?? [],
  }
}

router.get('/top', authMiddleware, subscriptionMiddleware, async (req: Request, res: Response) => {
  const chain = (req.query.chain as string) || 'solana'
  const period = (req.query.period as string) || '7D'
  const { page, pageSize, offset } = parsePagination(req.query as Record<string, unknown>)
  const sortBy = pickSortColumn(req.query.sortBy, WALLET_SORT_MAP, 'qualifiedTokens')
  const sortOrder = parseSortOrder(req.query.sortOrder)
  const numericFilters = parseNumericFilters(
    req.query as Record<string, unknown>,
    WALLET_FILTER_KEYS
  ) as Record<string, number>

  if (chain !== 'solana') {
    return res.json({
      items: [],
      page,
      pageSize,
      total: 0,
      lastUpdated: null,
      message: 'Only Solana is supported for live wallet rankings right now.',
    } satisfies PaginatedResult<ReturnType<typeof mapWalletRow>>)
  }

  const periodDays = isValidPeriod(period) ? periodToDays(period) : 7
  const filterKey = WALLET_FILTER_KEYS.map((key) => `${key}:${numericFilters[key] ?? ''}`).join('|')
  const cacheKey = `v6:wallets:top:${chain}:${period}:${page}:${pageSize}:${sortBy}:${sortOrder}:${filterKey}`
  const cached = await cacheGet<PaginatedResult<ReturnType<typeof mapWalletRow>>>(cacheKey)
  if (cached) return res.json(cached)

  if (isClickhouseConfigured()) {
    try {
      const total = await countClickhouseRows(
        'wallet_analytics',
        chain,
        periodDays,
        'smart-wallets',
        numericFilters
      )
      if (total > 0 || Object.keys(numericFilters).length > 0) {
        const rows = await queryClickhousePaginated<ClickhouseWallet>({
          table: 'wallet_analytics',
          chain,
          periodDays,
          sortColumn: sortBy,
          sortOrder,
          limit: pageSize,
          offset,
          filter: 'smart-wallets',
          numericFilters,
        })

        const [lastUpdated, nextUpdate] = await Promise.all([
          getSnapshotLastUpdated('wallet_analytics', chain, periodDays),
          getNextScheduledUpdate().catch(() => null),
        ])
        const result: PaginatedResult<ReturnType<typeof mapWalletRow>> = {
          items: rows.map((row, i) => mapWalletRow(row, offset + i + 1)),
          page,
          pageSize,
          total,
          lastUpdated,
          nextUpdate,
        }
        await cacheSet(cacheKey, result, 300)
        return res.json(result)
      }
    } catch (err) {
      console.warn('ClickHouse wallet query failed, falling back to mock data:', err)
    }
  }

  if (!isDemoMode()) {
    return res.json({
      items: [],
      page,
      pageSize,
      total: 0,
      lastUpdated: null,
      message: 'Smart-wallet data is not available yet. The alpha worker may still be backfilling.',
    })
  }

  const mock = getMockTopWallets(chain, period).filter((row) =>
    matchesWalletFilters(row as unknown as Record<string, unknown>, numericFilters)
  )
  const sorted = [...mock].sort((a, b) => {
    const key = (sortBy === 'smart_score'
      ? 'totalProfit'
      : Object.entries(WALLET_SORT_MAP).find(([, col]) => col === sortBy)?.[0]) as keyof typeof a | undefined
    const field = key ?? 'totalProfit'
    const av = a[field]
    const bv = b[field]
    if (typeof av === 'number' && typeof bv === 'number') {
      return sortOrder === 'asc' ? av - bv : bv - av
    }
    return sortOrder === 'asc'
      ? String(av).localeCompare(String(bv))
      : String(bv).localeCompare(String(av))
  })

  const items = sorted.slice(offset, offset + pageSize).map((row, i) => ({ ...row, rank: offset + i + 1 }))
  const result: PaginatedResult<(typeof items)[number]> = {
    items,
    page,
    pageSize,
    total: sorted.length,
    lastUpdated: null,
  }
  await cacheSet(cacheKey, result, 300)
  res.json(result)
})

router.get('/:address', authMiddleware, subscriptionMiddleware, async (req: Request, res: Response) => {
  const addressParam = req.params.address
  const address = Array.isArray(addressParam) ? addressParam[0] : addressParam
  const chain = (req.query.chain as string) || 'solana'
  const period = (req.query.period as string) || '7D'

  if (chain !== 'solana') {
    return res.status(400).json({ message: 'Only Solana wallet analysis is currently supported.' })
  }
  if (!isValidSolanaAddress(address)) {
    return res.status(400).json({ message: 'Invalid Solana wallet address.' })
  }

  const periodDays = isValidPeriod(period) ? periodToDays(period) : 7
  const cacheKey = `v2:wallet:detail:${chain}:${address}:${periodDays}`
  const cached = await cacheGet<Record<string, unknown>>(cacheKey)
  if (cached) return res.json(cached)

  try {
    const [summaries, periods, positions, rankRows] = await Promise.all([
      queryClickhouse<ClickhouseWalletPeriod>(
        `SELECT * FROM wallet_analytics FINAL
         WHERE chain = {chain:String} AND period_days = {periodDays:UInt16} AND address = {address:String}
         LIMIT 1`,
        { chain, periodDays, address }
      ),
      queryClickhouse<ClickhouseWalletPeriod>(
        `SELECT * FROM wallet_analytics FINAL
         WHERE chain = {chain:String} AND address = {address:String}
         ORDER BY period_days`,
        { chain, address }
      ),
      queryClickhouse<ClickhouseWalletPosition>(
        `SELECT
           p.contract AS contract, p.launched_at, p.first_buy_at, p.last_trade_at,
           p.entry_delay_minutes, p.buy_usd, p.sell_usd, p.bought_amount,
           p.sold_amount, p.remaining_amount, p.realized_pnl, p.unrealized_pnl,
           p.roi_pct, p.trade_count, p.suspicious_trade_count,
           ifNull(l.name, 'Unknown') AS name, ifNull(l.symbol, '???') AS symbol,
           ifNull(l.price, 0) AS current_price, ifNull(l.market_cap, 0) AS market_cap,
           ifNull(l.liquidity, 0) AS liquidity, ifNull(t.alpha_score, 0) AS alpha_score
         FROM wallet_token_performance AS p FINAL
         LEFT JOIN (
           SELECT contract, chain, name, symbol, price, market_cap, liquidity
           FROM token_launches FINAL
         ) AS l ON l.chain = p.chain AND l.contract = p.contract
         LEFT JOIN (
           SELECT contract, chain, alpha_score
           FROM token_analytics FINAL
           WHERE period_days = {periodDays:UInt16}
         ) AS t ON t.chain = p.chain AND t.contract = p.contract
         WHERE p.chain = {chain:String}
           AND p.period_days = {periodDays:UInt16}
           AND p.wallet_address = {address:String}
         ORDER BY p.last_trade_at DESC
         LIMIT 50`,
        { chain, periodDays, address }
      ),
      queryClickhouse<{ rank: string }>(
        `SELECT count() + 1 AS rank FROM wallet_analytics FINAL
         WHERE chain = {chain:String} AND period_days = {periodDays:UInt16}
           AND smart_score > (
             SELECT smart_score FROM wallet_analytics FINAL
             WHERE chain = {chain:String} AND period_days = {periodDays:UInt16}
               AND address = {address:String}
             LIMIT 1
           )`,
        { chain, periodDays, address }
      ),
    ])

    const summary = summaries[0]
    if (!summary && positions.length === 0) {
      return res.status(404).json({ message: 'No alpha analysis is available for this wallet yet.' })
    }

    const response = {
      address,
      chain,
      period: isValidPeriod(period) ? period : '7D',
      lastUpdated: summary?.updated_at ?? null,
      summary: summary
        ? {
            ...mapWalletRow(summary, Number(rankRows[0]?.rank ?? 0)),
            dataCoverage: 'full',
          }
        : {
            rank: null,
            address,
            balance: 0,
            totalProfit: positions.reduce(
              (sum, item) => sum + Number(item.realized_pnl) + Number(item.unrealized_pnl),
              0
            ),
            smartScore: 0,
            dataCoverage: 'positions_only',
          },
      periods: periods.map((item) => ({
        periodDays: Number(item.period_days),
        smartScore: Number(item.smart_score),
        totalProfit: Number(item.total_profit),
        realizedProfit: Number(item.realized_profit),
        unrealizedProfit: Number(item.unrealized_profit),
        winRate: Number(item.win_rate),
        trades: Number(item.trades),
      })),
      positions: positions.map((item) => ({
        contract: item.contract,
        name: item.name,
        symbol: item.symbol,
        launchedAt: item.launched_at,
        firstBuyAt: item.first_buy_at,
        lastTradeAt: item.last_trade_at,
        entryDelayMinutes: Number(item.entry_delay_minutes),
        buyUsd: Number(item.buy_usd),
        sellUsd: Number(item.sell_usd),
        boughtAmount: Number(item.bought_amount),
        soldAmount: Number(item.sold_amount),
        remainingAmount: Number(item.remaining_amount),
        realizedPnl: Number(item.realized_pnl),
        unrealizedPnl: Number(item.unrealized_pnl),
        roiPct: Number(item.roi_pct),
        tradeCount: Number(item.trade_count),
        suspiciousTradeCount: Number(item.suspicious_trade_count),
        currentPrice: Number(item.current_price),
        marketCap: Number(item.market_cap),
        liquidity: Number(item.liquidity),
        alphaScore: Number(item.alpha_score),
        isOpen: Number(item.remaining_amount) > 0,
      })),
    }
    await cacheSet(cacheKey, response, 300)
    return res.json(response)
  } catch (error) {
    console.error('Wallet detail query failed:', error)
    return res.status(500).json({ message: 'Unable to load wallet analysis.' })
  }
})

export default router
