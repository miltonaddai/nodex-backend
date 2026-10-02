import { Router, Request, Response } from 'express'
import { PaginatedResult, parsePagination, parseSortOrder, pickSortColumn } from '../lib/pagination'
import { getSnapshot, snapshotFreshUntil } from '../lib/snapshot-cache'
import { pageRows, sortRows } from '../lib/sort-rows'
import { config } from '../config'
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

/** The mapped field each sort column reads. */
const INSIDER_SORT_FIELDS = {
  insider_score: 'insiderScore',
  launch_score: 'launchScore',
  insider_holding_pct: 'insiderHoldingPct',
  insider_acquired_pct: 'insiderAcquiredPct',
  market_cap: 'marketCap',
  launched_at: 'launchedAt',
} as const

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

  // Every listed play is cached once (under a hundred tokens) and filtered, sorted and paged in
  // memory, so changing the sort, page or filters never waits on ClickHouse.
  const cacheKey = `v5:insiders:snapshot:${chain}`
  try {
    const snapshot = await getSnapshot(cacheKey, async () => {
      const [rows, schedule] = await Promise.all([
        queryClickhouse<InsiderRow>(
          `SELECT * FROM token_insider_analysis FINAL
           WHERE chain = {chain:String} AND launch_score >= {minLaunchScore:Float32}
             AND insider_acquired_pct >= {minAcquired:Float32}
             AND liquidity >= {minLiquidity:Float64}`,
          {
            chain,
            minLaunchScore: MIN_LAUNCH_SCORE,
            minAcquired: MIN_INSIDER_ACQUIRED_PCT,
            minLiquidity: config.worker.insiderMinLiquidity,
          }
        ),
        getPipelineSchedule().catch(() => null),
      ])
      const lastUpdated = rows.reduce<string | null>(
        (latest, row) => (!latest || row.updated_at > latest ? row.updated_at : latest),
        null
      )
      const value = {
        items: rows.map((row) => mapInsiderRow(row, 0)),
        lastUpdated: lastUpdated ? `${lastUpdated.replace(' ', 'T')}Z` : null,
        nextUpdate: schedule?.nextUpdate ?? null,
      }
      return { value, freshUntil: snapshotFreshUntil(schedule) }
    })
    if (!snapshot) return res.json(empty)
    const filtered = snapshot.items.filter(
      (item) => (!status || item.insiderStatus === status) && (!pattern || item.pricePattern === pattern)
    )
    const sorted = sortRows(filtered, [{ key: INSIDER_SORT_FIELDS[sortBy as keyof typeof INSIDER_SORT_FIELDS] ?? 'insiderScore', order: sortOrder }])
    const result: PaginatedResult<InsiderItem> = {
      items: pageRows(sorted, offset, pageSize),
      page,
      pageSize,
      total: filtered.length,
      lastUpdated: snapshot.lastUpdated,
      nextUpdate: snapshot.nextUpdate,
    }
    return res.json(result)
  } catch (err) {
    console.warn('ClickHouse insider query failed:', err)
    return res.json({ ...empty, message: 'Insider data is temporarily unavailable.' })
  }
})

export default router
