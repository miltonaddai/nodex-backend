import { Router, Request, Response } from 'express'
import { getMockTopTokens } from '../data/mock'
import { isValidPeriod, periodToDays, PERIOD_CONFIG } from '../lib/periods'
import { getSnapshot, snapshotFreshUntil } from '../lib/snapshot-cache'
import { pageRows, sortRows } from '../lib/sort-rows'
import { PaginatedResult, parseNumericFilters, parsePagination, parseSortOrder, pickSortColumn } from '../lib/pagination'
import { authMiddleware } from '../middleware/auth'
import { subscriptionMiddleware } from '../middleware/subscription'
import {
  getPipelineSchedule,
  getSnapshotLastUpdated,
  isClickhouseConfigured,
  queryClickhousePaginated,
} from '../services/clickhouse'
import { isDemoMode } from '../services/demo-auth'
import { withSightings } from '../services/token-sightings'

const router = Router()

/** Chains with a discovery step writing token_analytics. */
const TOKEN_CHAINS = new Set(['solana', 'robinhood'])

const TOKEN_SORT_MAP = {
  churn: 'churn',
  alphaScore: 'alpha_score',
  marketCap: 'market_cap',
  price: 'price',
  changePct: 'change_pct',
  volume: 'volume',
  holders: 'holders',
  liquidity: 'liquidity',
  launchedAt: 'launched_at',
  name: 'name',
  // Not ClickHouse columns: these come from token_sightings and are only sorted in memory.
  firstSeenAt: 'first_seen_at',
  peakMultiple: 'peak_multiple',
} as const

/** Upper bound on one chain and period's snapshot. Real snapshots hold a few hundred tokens. */
const SNAPSHOT_MAX_ROWS = 5000

type TokenItem = ReturnType<typeof mapTokenRow> & import('../services/token-sightings').SightingFields

/** The row field a sort column reads, e.g. market_cap -> marketCap. */
function tokenSortField(column: string): keyof TokenItem {
  const key = Object.entries(TOKEN_SORT_MAP).find(([, col]) => col === column)?.[0]
  return (key ?? 'churn') as keyof TokenItem
}

const TOKEN_FILTER_KEYS = [
  'minChurn',
  'maxChurn',
  'minPrice',
  'maxPrice',
  'minMarketCap',
  'maxMarketCap',
  'minChangePct',
  'maxChangePct',
  'minVolume',
  'maxVolume',
  'minLiquidity',
  'maxLiquidity',
  'minAgeDays',
  'maxAgeDays',
  'minHolders',
  'maxHolders',
] as const

const TOKEN_FILTER_FIELDS: Record<(typeof TOKEN_FILTER_KEYS)[number], string> = {
  minChurn: 'churn',
  maxChurn: 'churn',
  minPrice: 'price',
  maxPrice: 'price',
  minMarketCap: 'marketCap',
  maxMarketCap: 'marketCap',
  minChangePct: 'changePct',
  maxChangePct: 'changePct',
  minVolume: 'volume',
  maxVolume: 'volume',
  minLiquidity: 'liquidity',
  maxLiquidity: 'liquidity',
  minAgeDays: 'ageDays',
  maxAgeDays: 'ageDays',
  minHolders: 'holders',
  maxHolders: 'holders',
}

function matchesTokenFilters(row: Record<string, unknown>, filters: Record<string, number>): boolean {
  return Object.entries(filters).every(([key, limit]) => {
    const field = TOKEN_FILTER_FIELDS[key as keyof typeof TOKEN_FILTER_FIELDS]
    if (!field) return true
    const value = Number(row[field]) || 0
    return key.startsWith('min') ? value >= limit : value <= limit
  })
}

interface ClickhouseToken {
  name: string
  symbol: string
  image_url: string
  contract: string
  price: number
  market_cap: number
  change_pct: number
  volume: number
  holders: number
  liquidity: number
  launched_at: string
  age_days: number
  alpha_score: number
  smart_wallet_buyers: number
  smart_money_net_flow: number
  buy_acceleration: number
  qualified_wallet_buyers: number
  fresh_wallet_buyers: number
  fresh_wallet_share: number
  evidence_tier: string
  real_buyers: number
  independent_buyers: number
  net_inflow_usd: number
  retention_rate: number
  demand_persistence: number
  sniper_share: number
  top_buyer_share: number
  wash_ratio: number
  churn: number
  unique_wallet_24h: number
  buy_sell_ratio: number
  wealthy_holders: number
  median_holder_wealth_usd: number
  enriched_holders: number
  risk_flags: string[]
}

function changeColumnLabel(period: string): string {
  if (!isValidPeriod(period)) return 'Change'
  if (period === '24H') return '24H Change'
  if (period === '7D') return '7D Change'
  if (period === '30D') return '30D Change'
  return 'Change'
}

router.get('/top', authMiddleware, subscriptionMiddleware, async (req: Request, res: Response) => {
  const chain = (req.query.chain as string) || 'solana'
  const period = (req.query.period as string) || '7D'
  const { page, pageSize, offset } = parsePagination(req.query as Record<string, unknown>)
  // Churn is the ranking signal: it is the one metric that separated hand-verified legitimate
  // tokens from bundles, and unlike alpha_score it is populated at discovery time.
  const sortBy = pickSortColumn(req.query.sortBy, TOKEN_SORT_MAP, 'churn')
  const sortOrder = parseSortOrder(req.query.sortOrder)
  const numericFilters = parseNumericFilters(
    req.query as Record<string, unknown>,
    TOKEN_FILTER_KEYS
  ) as Record<string, number>

  if (!TOKEN_CHAINS.has(chain)) {
    return res.json({
      items: [],
      page,
      pageSize,
      total: 0,
      lastUpdated: null,
      changeColumnLabel: changeColumnLabel(period),
      message: 'Live token rankings cover Solana and Robinhood Chain.',
    })
  }

  const periodDays = isValidPeriod(period) ? periodToDays(period) : PERIOD_CONFIG['7D'].days
  // One cached snapshot per chain and period. Sorting, filtering and paging happen in memory, so
  // a new sort or page never waits on ClickHouse.
  const cacheKey = `v9:tokens:snapshot:${chain}:${periodDays}`

  if (isClickhouseConfigured()) {
    try {
      const snapshot = await getSnapshot(cacheKey, async () => {
        const rows = await queryClickhousePaginated<ClickhouseToken>({
          table: 'token_analytics',
          chain,
          periodDays,
          sortColumn: 'churn',
          sortOrder: 'desc',
          limit: SNAPSHOT_MAX_ROWS,
          offset: 0,
          filter: 'recent-tokens',
        })
        if (rows.length === 0) return null
        const [lastUpdated, schedule] = await Promise.all([
          getSnapshotLastUpdated('token_analytics', chain, periodDays),
          getPipelineSchedule().catch(() => null),
        ])
        const value = {
          items: await withSightings(chain, rows.map((row) => mapTokenRow(row, 0))),
          lastUpdated,
          nextUpdate: schedule?.nextUpdate ?? null,
        }
        return { value, freshUntil: snapshotFreshUntil(schedule) }
      })
      if (snapshot) {
        const filtered = snapshot.items.filter((row) =>
          matchesTokenFilters(row as unknown as Record<string, unknown>, numericFilters)
        )
        // Same tie-breaks as the SQL ordering this replaced.
        const sorted = sortRows(filtered, [
          { key: tokenSortField(sortBy), order: sortOrder },
          { key: 'independentBuyers', order: 'desc' },
          { key: 'volume', order: 'desc' },
        ])
        return res.json({
          items: pageRows(sorted, offset, pageSize),
          page,
          pageSize,
          total: filtered.length,
          lastUpdated: snapshot.lastUpdated,
          nextUpdate: snapshot.nextUpdate,
          changeColumnLabel: changeColumnLabel(period),
        })
      }
    } catch (err) {
      console.warn('ClickHouse token query failed, falling back to mock data:', err)
    }
  }

  if (!isDemoMode()) {
    return res.json({
      items: [],
      page,
      pageSize,
      total: 0,
      lastUpdated: null,
      changeColumnLabel: changeColumnLabel(period),
      message: 'Recent-token alpha data is not available yet. The alpha worker may still be backfilling.',
    })
  }

  const mock = getMockTopTokens(chain, period).filter((row) =>
    matchesTokenFilters(row as unknown as Record<string, unknown>, numericFilters)
  )
  const sorted = [...mock].sort((a, b) => {
    const key = (sortBy === 'alpha_score'
      ? 'marketCap'
      : Object.entries(TOKEN_SORT_MAP).find(([, col]) => col === sortBy)?.[0]) as keyof typeof a | undefined
    const field = key ?? 'marketCap'
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
  res.json({
    items,
    page,
    pageSize,
    total: sorted.length,
    lastUpdated: null,
    changeColumnLabel: changeColumnLabel(period),
  })
})

function mapTokenRow(row: ClickhouseToken, rank: number) {
  return {
    rank,
    name: row.name,
    symbol: row.symbol,
    imageUrl: row.image_url || undefined,
    contract: row.contract,
    price: Number(row.price) || 0,
    marketCap: Number(row.market_cap) || 0,
    changePct: Number(row.change_pct) || 0,
    volume: Number(row.volume) || 0,
    holders: Number(row.holders) || 0,
    liquidity: Number(row.liquidity) || 0,
    launchedAt: row.launched_at,
    ageDays: Number(row.age_days) || 0,
    alphaScore: Number(row.alpha_score) || 0,
    smartWalletBuyers: Number(row.smart_wallet_buyers) || 0,
    smartMoneyNetFlow: Number(row.smart_money_net_flow) || 0,
    buyAcceleration: Number(row.buy_acceleration) || 0,
    qualifiedWalletBuyers: Number(row.qualified_wallet_buyers) || 0,
    freshWalletBuyers: Number(row.fresh_wallet_buyers) || 0,
    freshWalletShare: Number(row.fresh_wallet_share) || 0,
    evidenceTier: row.evidence_tier || 'unverified',
    realBuyers: Number(row.real_buyers) || 0,
    independentBuyers: Number(row.independent_buyers) || 0,
    netInflowUsd: Number(row.net_inflow_usd) || 0,
    retentionRate: Number(row.retention_rate) || 0,
    demandPersistence: Number(row.demand_persistence) || 0,
    sniperShare: Number(row.sniper_share) || 0,
    topBuyerShare: Number(row.top_buyer_share) || 0,
    washRatio: Number(row.wash_ratio) || 0,
    churn: Number(row.churn) || 0,
    uniqueWallet24h: Number(row.unique_wallet_24h) || 0,
    buySellRatio: Number(row.buy_sell_ratio) || 0,
    wealthyHolders: Number(row.wealthy_holders) || 0,
    medianHolderWealthUsd: Number(row.median_holder_wealth_usd) || 0,
    enrichedHolders: Number(row.enriched_holders) || 0,
    riskFlags: row.risk_flags ?? [],
  }
}

export default router
