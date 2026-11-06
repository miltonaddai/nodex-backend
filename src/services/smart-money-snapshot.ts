import { queryClickhouse } from './clickhouse'
import { withSightings, type SightingFields } from './token-sightings'

/**
 * The latest smart-money snapshot for a chain: every token the tracked traders are net buying,
 * with first-seen and peak fields. Shared by the /smart-money/buys route (which caches it) and the
 * Telegram alert step in the worker, so both judge alerts against exactly the same tokens.
 */

export interface BuyRow {
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

export interface WalletRow {
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

export function iso(value: string): string {
  return `${value.replace(' ', 'T')}Z`
}

export const LATEST_WALLETS = `SELECT wallet, rank, pnl_30d, realized_pnl_30d, volume_30d, trades_30d, handle, display_name,
    avatar_url, followers, updated_at
  FROM smart_money_wallets FINAL
  WHERE chain = {chain:String}
    AND updated_at = (SELECT max(updated_at) FROM smart_money_wallets WHERE chain = {chain:String})`

export function mapWallet(row: WalletRow) {
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

export function mapBuy(row: BuyRow, rank: number, walletsByAddress: Map<string, TrackedWallet>) {
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

export type BuyItem = ReturnType<typeof mapBuy> & SightingFields

/** Loads the latest snapshot for a chain straight from ClickHouse (no cache). */
export async function loadBuysSnapshot(chain: string): Promise<{
  rows: BuyRow[]
  items: BuyItem[]
  trackedWallets: number
  lastUpdated: string | null
}> {
  const latest = `snapshot_at = (SELECT max(snapshot_at) FROM smart_money_buys WHERE chain = {chain:String})`
  const [rows, walletRows] = await Promise.all([
    queryClickhouse<BuyRow>(`SELECT * FROM smart_money_buys WHERE chain = {chain:String} AND ${latest}`, { chain }),
    queryClickhouse<WalletRow>(LATEST_WALLETS, { chain }),
  ])
  const walletsByAddress = new Map(walletRows.map((row) => [row.wallet, mapWallet(row)]))
  return {
    rows,
    items: await withSightings(chain, rows.map((row) => mapBuy(row, 0, walletsByAddress))),
    trackedWallets: walletRows.length,
    lastUpdated: rows[0]?.snapshot_at ? iso(rows[0].snapshot_at) : null,
  }
}
