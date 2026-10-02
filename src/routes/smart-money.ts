import { Router, Request, Response } from 'express'
import { config } from '../config'
import { PaginatedResult, parsePagination, parseSortOrder, pickSortColumn } from '../lib/pagination'
import { getSnapshot, snapshotFreshUntil } from '../lib/snapshot-cache'
import { pageRows, sortRows, type SortKey } from '../lib/sort-rows'
import { authMiddleware } from '../middleware/auth'
import { subscriptionMiddleware } from '../middleware/subscription'
import { getPipelineSchedule, isClickhouseConfigured, queryClickhouse } from '../services/clickhouse'

const router = Router()

/** Chains the smart money worker covers. */
const CHAINS = new Set(['solana', 'robinhood'])

const BUY_SORT_MAP = {
  walletCount: 'wallet_count',
  netBuyUsd: 'net_buy_usd',
  marketCap: 'market_cap',
  lastBuyAt: 'last_buy_at',
  priceChange24h: 'price_change_24h',
  buyerProfit: 'buyer_realized_pnl_30d',
} as const

/** The mapped field each sort column reads. */
const BUY_SORT_FIELDS = {
  wallet_count: 'walletCount',
  net_buy_usd: 'netBuyUsd',
  market_cap: 'marketCap',
  last_buy_at: 'lastBuyAt',
  price_change_24h: 'priceChange24h',
  buyer_realized_pnl_30d: 'buyerRealizedPnl30d',
} as const

interface BuyRow {
  contract: string
  symbol: string
  name: string
  image_url: string
  wallet_count: number
  buy_usd: number
  sell_usd: number
  net_buy_usd: number
  buy_count: number
  wallets: string[]
  wallet_net_buy_usd: number[]
  wallet_last_buy_at: string[]
  first_buy_at: string
  last_buy_at: string
  price: number
  market_cap: number
  liquidity: number
  volume_24h: number
  price_change_24h: number
  buyer_realized_pnl_30d: number
  snapshot_at: string
}

interface WalletRow {
  wallet: string
  rank: number
  pnl_30d: number
  realized_pnl_30d: number
  volume_30d: number
  trades_30d: number
  handle: string
  display_name: string
  avatar_url: string
  followers: number
  updated_at: string
}

function iso(value: string): string {
  return `${value.replace(' ', 'T')}Z`
}

const LATEST_WALLETS = `SELECT wallet, rank, pnl_30d, realized_pnl_30d, volume_30d, trades_30d, handle, display_name,
    avatar_url, followers, updated_at
  FROM smart_money_wallets FINAL
  WHERE chain = {chain:String}
    AND updated_at = (SELECT max(updated_at) FROM smart_money_wallets WHERE chain = {chain:String})`

function mapWallet(row: WalletRow) {
  return {
    address: row.wallet,
    rank: Number(row.rank),
    pnl30d: Number(row.pnl_30d),
    realizedPnl30d: Number(row.realized_pnl_30d),
    volume30d: Number(row.volume_30d),
    trades30d: Number(row.trades_30d),
    handle: row.handle || null,
    displayName: row.display_name || null,
    avatarUrl: row.avatar_url || null,
    followers: Number(row.followers),
  }
}

type TrackedWallet = ReturnType<typeof mapWallet>

function mapBuy(row: BuyRow, rank: number, walletsByAddress: Map<string, TrackedWallet>) {
  return {
    rank,
    contract: row.contract,
    symbol: row.symbol,
    name: row.name,
    imageUrl: row.image_url,
    walletCount: Number(row.wallet_count),
    buyUsd: Number(row.buy_usd),
    sellUsd: Number(row.sell_usd),
    netBuyUsd: Number(row.net_buy_usd),
    buyCount: Number(row.buy_count),
    firstBuyAt: iso(row.first_buy_at),
    lastBuyAt: iso(row.last_buy_at),
    price: Number(row.price),
    marketCap: Number(row.market_cap),
    liquidity: Number(row.liquidity),
    volume24h: Number(row.volume_24h),
    priceChange24h: Number(row.price_change_24h),
    buyerRealizedPnl30d: Number(row.buyer_realized_pnl_30d),
    wallets: row.wallets.map((address, i) => ({
      address,
      netBuyUsd: Number(row.wallet_net_buy_usd[i] ?? 0),
      lastBuyAt: row.wallet_last_buy_at[i] ? iso(row.wallet_last_buy_at[i]) : null,
      rank: walletsByAddress.get(address)?.rank ?? null,
      realizedPnl30d: walletsByAddress.get(address)?.realizedPnl30d ?? null,
      handle: walletsByAddress.get(address)?.handle ?? null,
      displayName: walletsByAddress.get(address)?.displayName ?? null,
      avatarUrl: walletsByAddress.get(address)?.avatarUrl ?? null,
    })),
  }
}

type BuyItem = ReturnType<typeof mapBuy>

interface BuysResult extends PaginatedResult<BuyItem> {
  trackedWallets: number
  windowHours: number
}

/** Tokens the most profitable wallets of the last 30 days are net buying, from the latest run. */
router.get('/buys', authMiddleware, subscriptionMiddleware, async (req: Request, res: Response) => {
  const chain = (req.query.chain as string) || 'solana'
  const { page, pageSize, offset } = parsePagination(req.query as Record<string, unknown>, 20)
  const sortBy = pickSortColumn(req.query.sortBy, BUY_SORT_MAP, 'walletCount')
  const sortOrder = parseSortOrder(req.query.sortOrder)
  const empty: BuysResult = {
    items: [],
    page,
    pageSize,
    total: 0,
    lastUpdated: null,
    trackedWallets: 0,
    windowHours: config.worker.smartMoneyBuyWindowHours,
  }
  if (!CHAINS.has(chain)) return res.json({ ...empty, message: 'Smart money tracking covers Solana and Robinhood Chain.' })
  if (!isClickhouseConfigured()) return res.json(empty)

  // The whole latest run is cached once per chain (a couple of hundred tokens) and sorted and
  // paged in memory, so a new sort or page never waits on ClickHouse.
  const cacheKey = `v4:smart-money:buys:snapshot:${chain}`
  try {
    const snapshot = await getSnapshot(cacheKey, async () => {
      const latest = `snapshot_at = (SELECT max(snapshot_at) FROM smart_money_buys WHERE chain = {chain:String})`
      const [rows, walletRows, schedule] = await Promise.all([
        queryClickhouse<BuyRow>(`SELECT * FROM smart_money_buys WHERE chain = {chain:String} AND ${latest}`, { chain }),
        queryClickhouse<WalletRow>(LATEST_WALLETS, { chain }),
        getPipelineSchedule().catch(() => null),
      ])
      const walletsByAddress = new Map(walletRows.map((row) => [row.wallet, mapWallet(row)]))
      const value = {
        items: rows.map((row) => mapBuy(row, 0, walletsByAddress)),
        lastUpdated: rows[0]?.snapshot_at ? iso(rows[0].snapshot_at) : null,
        nextUpdate: schedule?.nextUpdate ?? null,
        trackedWallets: walletRows.length,
      }
      return { value, freshUntil: snapshotFreshUntil(schedule) }
    })
    if (!snapshot) return res.json(empty)
    // Ties on wallet count go to more profitable buyers, then to larger buys.
    const keys: SortKey<BuyItem>[] = [
      { key: BUY_SORT_FIELDS[sortBy as keyof typeof BUY_SORT_FIELDS] ?? 'walletCount', order: sortOrder },
    ]
    if (sortBy === 'wallet_count') {
      keys.push({ key: 'buyerRealizedPnl30d', order: sortOrder }, { key: 'netBuyUsd', order: sortOrder })
    }
    const result: BuysResult = {
      items: pageRows(sortRows(snapshot.items, keys), offset, pageSize),
      page,
      pageSize,
      total: snapshot.items.length,
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
