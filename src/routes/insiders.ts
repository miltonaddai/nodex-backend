import { Router, Request, Response } from 'express'
import { PaginatedResult, parsePagination, parseSortOrder, pickSortColumn } from '../lib/pagination'
import { getSnapshot, snapshotFreshUntil } from '../lib/snapshot-cache'
import { authMiddleware } from '../middleware/auth'
import { subscriptionMiddleware } from '../middleware/subscription'
import { getPipelineSchedule, isClickhouseConfigured, queryClickhouse } from '../services/clickhouse'

const router = Router()

const INSIDER_SORT_MAP = {
  insiderScore: 'insider_score',
  launchScore: 'launch_score',
  insiderHolding: 'insider_holding_pct',
  insiderAcquired: 'insider_acquired_pct',
  marketCap: 'market_cap',
  launchedAt: 'launched_at',
} as const

/**
 * Below this launch score the evidence is a stray fee-paid buy or two, which ordinary launches
 * also show. Listing those would bury the real bundles.
 */
const MIN_LAUNCH_SCORE = 20
/**
 * Link counts alone can clear the score bar: many fee-paid or co-signed dust buys add points
 * without controlling supply. A play needs insiders holding a real share after the launch.
 */
const MIN_INSIDER_ACQUIRED_PCT = 1

const STATUSES = new Set(['holding', 'distributing', 'exited'])
const PATTERNS = new Set(['reclaiming', 'retracing', 'new_highs', 'ranging'])

interface InsiderRow {
  contract: string
  name: string
  symbol: string
  image_url: string
  launched_at: string
  launch_buyers: number
  creation_block_supply_pct: number
  linked_wallets: number
  linked_supply_pct: number
  clusters: number
  largest_cluster_supply_pct: number
  insider_wallets: string[]
  insider_acquired_pct: number
  insider_holding_pct: number
  insider_status: string
  launch_score: number
  insider_score: number
  evidence: string[]
  price: number
  market_cap: number
  liquidity: number
  volume_24h: number
  price_change_24h: number
  holders: number
  launch_high_mc: number
  post_launch_low_mc: number
  ath_mc: number
  price_pattern: string
  updated_at: string
}

function mapInsiderRow(row: InsiderRow, rank: number) {
  return {
    rank,
    contract: row.contract,
    name: row.name,
    symbol: row.symbol,
    imageUrl: row.image_url,
    launchedAt: row.launched_at,
    launchBuyers: Number(row.launch_buyers),
    creationBlockSupplyPct: Number(row.creation_block_supply_pct),
    linkedWallets: Number(row.linked_wallets),
    linkedSupplyPct: Number(row.linked_supply_pct),
    clusters: Number(row.clusters),
    largestClusterSupplyPct: Number(row.largest_cluster_supply_pct),
    insiderWallets: row.insider_wallets,
    insiderAcquiredPct: Number(row.insider_acquired_pct),
    insiderHoldingPct: Number(row.insider_holding_pct),
    insiderStatus: row.insider_status,
    launchScore: Number(row.launch_score),
    insiderScore: Number(row.insider_score),
    evidence: row.evidence,
    price: Number(row.price),
    marketCap: Number(row.market_cap),
    liquidity: Number(row.liquidity),
    volume24h: Number(row.volume_24h),
    priceChange24h: Number(row.price_change_24h),
    holders: Number(row.holders),
    launchHighMc: Number(row.launch_high_mc),
    postLaunchLowMc: Number(row.post_launch_low_mc),
    athMc: Number(row.ath_mc),
    pricePattern: row.price_pattern,
  }
}

type InsiderItem = ReturnType<typeof mapInsiderRow>

/** Tokens whose launch was bought by wallets under common control, strongest first. */
router.get('/', authMiddleware, subscriptionMiddleware, async (req: Request, res: Response) => {
  const chain = (req.query.chain as string) || 'solana'
  const { page, pageSize, offset } = parsePagination(req.query as Record<string, unknown>)
  const sortBy = pickSortColumn(req.query.sortBy, INSIDER_SORT_MAP, 'insiderScore')
  const sortOrder = parseSortOrder(req.query.sortOrder)
  const status = STATUSES.has(String(req.query.status)) ? String(req.query.status) : ''
  const pattern = PATTERNS.has(String(req.query.pattern)) ? String(req.query.pattern) : ''

  const empty: PaginatedResult<InsiderItem> = { items: [], page, pageSize, total: 0, lastUpdated: null }
  if (chain !== 'solana') {
    return res.json({ ...empty, message: 'Insider detection currently covers Solana only.' })
  }
  if (!isClickhouseConfigured()) return res.json(empty)

  const cacheKey = `v3:insiders:${chain}:${page}:${pageSize}:${sortBy}:${sortOrder}:${status}:${pattern}`
  try {
    const result = await getSnapshot(cacheKey, async () => {
      const where = `chain = {chain:String} AND launch_score >= {minLaunchScore:Float32}
        AND insider_acquired_pct >= {minAcquired:Float32}
        ${status ? 'AND insider_status = {status:String}' : ''}
        ${pattern ? 'AND price_pattern = {pattern:String}' : ''}`
      const params = { chain, status, pattern, minLaunchScore: MIN_LAUNCH_SCORE, minAcquired: MIN_INSIDER_ACQUIRED_PCT, limit: pageSize, offset }
      const [countRows, rows, schedule] = await Promise.all([
        queryClickhouse<{ total: string }>(
          `SELECT count() AS total FROM token_insider_analysis FINAL WHERE ${where}`,
          params
        ),
        queryClickhouse<InsiderRow>(
          `SELECT * FROM token_insider_analysis FINAL WHERE ${where}
           ORDER BY ${sortBy} ${sortOrder === 'asc' ? 'ASC' : 'DESC'}
           LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
          params
        ),
        getPipelineSchedule().catch(() => null),
      ])
      const lastUpdated = rows.reduce<string | null>(
        (latest, row) => (!latest || row.updated_at > latest ? row.updated_at : latest),
        null
      )
      const value: PaginatedResult<InsiderItem> = {
        items: rows.map((row, i) => mapInsiderRow(row, offset + i + 1)),
        page,
        pageSize,
        total: Number(countRows[0]?.total ?? 0),
        lastUpdated: lastUpdated ? `${lastUpdated.replace(' ', 'T')}Z` : null,
        nextUpdate: schedule?.nextUpdate ?? null,
      }
      return { value, freshUntil: snapshotFreshUntil(schedule) }
    })
    return res.json(result ?? empty)
  } catch (err) {
    console.warn('ClickHouse insider query failed:', err)
    return res.json({ ...empty, message: 'Insider data is temporarily unavailable.' })
  }
})

export default router
