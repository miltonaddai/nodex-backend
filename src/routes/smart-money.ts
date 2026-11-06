import { Router, Request, Response } from 'express'
import { config } from '../config'
import { coveredChainsText, SUPPORTED_CHAINS } from '../lib/chains'
import { PaginatedResult, parsePagination, parseSortOrder, pickSortColumn } from '../lib/pagination'
import { getSnapshot, snapshotFreshUntil } from '../lib/snapshot-cache'
import { isEarlySignal } from '../lib/early-signal'
import { iso, LATEST_WALLETS, loadBuysSnapshot, mapWallet, type BuyItem, type WalletRow } from '../services/smart-money-snapshot'
import { matchesRules, parseRules } from '../lib/custom-filters'
import { pageRows, sortRows, type SortKey } from '../lib/sort-rows'
import { authMiddleware } from '../middleware/auth'
import { subscriptionMiddleware } from '../middleware/subscription'
import { getPipelineSchedule, isClickhouseConfigured, queryClickhouse } from '../services/clickhouse'

const router = Router()

/** Chains the smart money worker covers. */
const CHAINS = new Set<string>(SUPPORTED_CHAINS)

const BUY_SORT_MAP = {
  walletCount: 'wallet_count',
  netBuyUsd: 'net_buy_usd',
  marketCap: 'market_cap',
  lastBuyAt: 'last_buy_at',
  priceChange24h: 'price_change_24h',
  buyerProfit: 'buyer_realized_pnl_30d',
  firstSeenAt: 'first_seen_at',
  peakMultiple: 'peak_multiple',
} as const

/** The mapped field each sort column reads. */
const BUY_SORT_FIELDS = {
  wallet_count: 'walletCount',
  net_buy_usd: 'netBuyUsd',
  market_cap: 'marketCap',
  last_buy_at: 'lastBuyAt',
  price_change_24h: 'priceChange24h',
  buyer_realized_pnl_30d: 'buyerRealizedPnl30d',
  first_seen_at: 'firstSeenAt',
  peak_multiple: 'peakMultiple',
} as const


interface BuysResult extends PaginatedResult<BuyItem & { earlySignal?: boolean }> {
  /** Tokens meeting the early-signal preset in the whole snapshot, whatever the filters. */
  earlySignalCount?: number
  trackedWallets: number
  windowHours: number
}

/** Tokens the most profitable wallets of the last 30 days are net buying, from the latest run. */
router.get('/buys', authMiddleware, subscriptionMiddleware, async (req: Request, res: Response) => {
  const chain = (req.query.chain as string) || 'solana'
  const { page, pageSize, offset } = parsePagination(req.query as Record<string, unknown>, 20)
  const sortBy = pickSortColumn(req.query.sortBy, BUY_SORT_MAP, 'walletCount')
  const sortOrder = parseSortOrder(req.query.sortOrder)
  // Optional filters, applied to the cached snapshot. A missing or invalid value means no limit.
  const positive = (value: unknown) => {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  const maxMarketCap = positive(req.query.maxMarketCap)
  const minWalletCount = positive(req.query.minWalletCount)
  const earlyOnly = req.query.preset === 'early'
  // The user's own filter rules, from the custom filter builder.
  const rules = parseRules(req.query.rules)
  const empty: BuysResult = {
    items: [],
    page,
    pageSize,
    total: 0,
    lastUpdated: null,
    trackedWallets: 0,
    windowHours: config.worker.smartMoneyBuyWindowHours,
  }
  if (!CHAINS.has(chain)) return res.json({ ...empty, message: `Smart money tracking covers ${coveredChainsText()}.` })
  if (!isClickhouseConfigured()) return res.json(empty)

  // The whole latest run is cached once per chain (a couple of hundred tokens) and sorted and
  // paged in memory, so a new sort or page never waits on ClickHouse.
  const cacheKey = `v5:smart-money:buys:snapshot:${chain}`
  try {
    const snapshot = await getSnapshot(cacheKey, async () => {
      const [loaded, schedule] = await Promise.all([loadBuysSnapshot(chain), getPipelineSchedule().catch(() => null)])
      const value = {
        items: loaded.items,
        lastUpdated: loaded.lastUpdated,
        nextUpdate: schedule?.nextUpdate ?? null,
        trackedWallets: loaded.trackedWallets,
      }
      return { value, freshUntil: snapshotFreshUntil(schedule) }
    })
    if (!snapshot) return res.json(empty)
    // A pool holds at most about twice a token's market cap in liquidity (when most supply sits
    // in it). Far more than that means the market cap figure is wrong, as with bridged tokens
    // whose supply Dexscreener misreports, so those rows are left out of a market cap filter.
    const plausibleCap = (item: BuyItem) => item.marketCap > 0 && item.liquidity <= item.marketCap * 3
    // Flagged at response time so a rule change applies without waiting for a new snapshot.
    const flagged = snapshot.items.map((item) => ({ ...item, earlySignal: isEarlySignal(item) }))
    const matching = flagged.filter(
      (item) =>
        (!earlyOnly || item.earlySignal) &&
        (maxMarketCap === null || (plausibleCap(item) && item.marketCap <= maxMarketCap)) &&
        (minWalletCount === null || item.walletCount >= minWalletCount) &&
        (rules.length === 0 || matchesRules(item, rules))
    )
    // Ties on wallet count go to more profitable buyers, then to larger buys.
    const keys: SortKey<BuyItem>[] = [
      { key: BUY_SORT_FIELDS[sortBy as keyof typeof BUY_SORT_FIELDS] ?? 'walletCount', order: sortOrder },
    ]
    if (sortBy === 'wallet_count') {
      keys.push({ key: 'buyerRealizedPnl30d', order: sortOrder }, { key: 'netBuyUsd', order: sortOrder })
    }
    const result: BuysResult = {
      earlySignalCount: flagged.filter((item) => item.earlySignal).length,
      items: pageRows(sortRows(matching, keys), offset, pageSize),
      page,
      pageSize,
      total: matching.length,
      lastUpdated: snapshot.lastUpdated,
      nextUpdate: snapshot.nextUpdate,
      trackedWallets: snapshot.trackedWallets,
      windowHours: config.worker.smartMoneyBuyWindowHours,
    }
    return res.json(result)
  } catch (err) {
    console.warn('ClickHouse smart money query failed:', err)
    return res.json({ ...empty, message: 'Smart money data is temporarily unavailable.' })
  }
})

/** The wallets being tracked: the most profitable of the last 30 days, by realized profit. */
router.get('/wallets', authMiddleware, subscriptionMiddleware, async (req: Request, res: Response) => {
  const chain = (req.query.chain as string) || 'solana'
  if (!CHAINS.has(chain) || !isClickhouseConfigured()) return res.json({ items: [], lastUpdated: null })
  try {
    const result = await getSnapshot(`v3:smart-money:wallets:${chain}`, async () => {
      const [rows, schedule] = await Promise.all([
        queryClickhouse<WalletRow>(`${LATEST_WALLETS} ORDER BY rank`, { chain }),
        getPipelineSchedule().catch(() => null),
      ])
      return {
        value: { items: rows.map(mapWallet), lastUpdated: rows[0]?.updated_at ? iso(rows[0].updated_at) : null },
        freshUntil: snapshotFreshUntil(schedule),
      }
    })
    return res.json(result ?? { items: [], lastUpdated: null })
  } catch (err) {
    console.warn('ClickHouse smart money wallet query failed:', err)
    return res.json({ items: [], lastUpdated: null })
  }
})

export default router
