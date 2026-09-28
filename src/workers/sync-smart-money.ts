import { config } from '../config'
import {
  aggregateBuying,
  isLiveTradingWallet,
  selectSmartWallets,
  summarizeWalletFlows,
  type Swap,
  type TokenFlow,
} from '../lib/smart-money'
import { getProfitLeaderboardPage, getWalletSwapsSince, type LeaderboardTrader } from '../services/birdeye'
import { insertClickhouse, queryClickhouse } from '../services/clickhouse'
import { getSolanaTokenInfo, getSolanaTokenMarketHealth } from '../services/dexscreener'
import { getAccountSummaries, getLastActivityTime } from '../services/helius'
import { cacheDeletePattern } from '../services/redis'

/**
 * Smart money: tokens the most profitable wallets of the last 30 days are net buying now.
 *
 * The wallet list comes from Birdeye's 30-day leaderboard and changes slowly, so it is refreshed
 * once a day. What those wallets are buying is refreshed every run.
 */

interface TrackedWallet {
  wallet: string
  rank: number
  realized_pnl_30d: number
}

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace('T', ' ').slice(0, 19)
}

/**
 * Keeps leaderboard wallets that are still live, in profit order, until `limit` are found.
 * Account lookups are batched, so only the recent-activity check costs a call per wallet.
 */
async function keepLiveWallets(candidates: LeaderboardTrader[], limit: number): Promise<LeaderboardTrader[]> {
  const accounts = await getAccountSummaries(candidates.map((trader) => trader.address))
  const now = Math.floor(Date.now() / 1000)
  const opts = { minSol: config.worker.smartMoneyMinSolBalance, maxIdleDays: config.worker.smartMoneyMaxIdleDays, now }
  const live: LeaderboardTrader[] = []
  for (const trader of candidates) {
    if (live.length >= limit) break
    const account = accounts.get(trader.address)
    // Skip the activity lookup for addresses that already fail on ownership or balance.
    if (!isLiveTradingWallet(account, now, opts)) continue
    try {
      if (isLiveTradingWallet(account, await getLastActivityTime(trader.address), opts)) live.push(trader)
    } catch {
      // An address whose activity cannot be checked is left out rather than guessed at.
    }
  }
  return live
}

/** Rebuilds the tracked wallet list when it is older than the refresh interval, or when forced. */
export async function refreshLeaderboardIfStale(chain: string, force = false): Promise<void> {
  const [latest] = await queryClickhouse<{ age_hours: number | null }>(
    `SELECT dateDiff('hour', max(updated_at), now()) AS age_hours
     FROM smart_money_wallets WHERE chain = {chain:String}`,
    { chain }
  )
  const age = latest?.age_hours
  if (!force && age !== null && age !== undefined && Number(age) < config.worker.smartMoneyLeaderboardRefreshHours) {
    const [{ n }] = await queryClickhouse<{ n: string }>(
      `SELECT count() AS n FROM smart_money_wallets WHERE chain = {chain:String}`,
      { chain }
    )
    if (Number(n) > 0) return
  }

  const traders: LeaderboardTrader[] = []
  for (let offset = 0; offset < config.worker.smartMoneyLeaderboardDepth; offset += 50) {
    const page = await getProfitLeaderboardPage('30d', offset, 50)
    traders.push(...page)
    if (page.length < 50) break
  }
  const profitable = selectSmartWallets(traders, config.worker.smartMoneyMinTrades30d, Number.POSITIVE_INFINITY)
  const picked = await keepLiveWallets(profitable, config.worker.smartMoneyWallets)
  if (picked.length === 0) {
    console.warn(`[smart-money] No live profitable wallets found in ${traders.length} leaderboard rows; keeping the previous list`)
    return
  }

  const updatedAt = formatDate(Math.floor(Date.now() / 1000))
  await insertClickhouse(
    'smart_money_wallets',
    picked.map((trader, index) => ({
      wallet: trader.address,
      chain,
      rank: index + 1,
      pnl_30d: trader.pnl,
      realized_pnl_30d: trader.realizedPnl,
      volume_30d: trader.volume,
      trades_30d: Math.round(trader.trades),
      updated_at: updatedAt,
    }))
  )
  console.log(
    `[smart-money] Leaderboard refreshed: ${profitable.length} of ${traders.length} wallets have real 30-day profit, ` +
      `tracking the top ${picked.length} that are live wallets`
  )
}

interface StoredSwap {
  wallet: string
  block_time: number
  volume_usd: number
  base_address: string
  base_symbol: string
  base_change: number
  quote_address: string
  quote_symbol: string
  quote_change: number
}

/**
 * Stores each wallet's swaps since the last run. A wallet with swaps already stored is first
 * checked for any new transaction (one cheap Helius call) and skipped if it has none, so a
 * Birdeye call is only spent on wallets that actually traded. Wallets with nothing stored are
 * backfilled across the whole window once.
 */
async function fetchNewSwaps(
  chain: string,
  wallets: TrackedWallet[],
  windowStart: number
): Promise<{ fetched: number; skipped: number; stored: number }> {
  const latestRows = await queryClickhouse<{ wallet: string; latest: string }>(
    `SELECT wallet, toUnixTimestamp(max(block_time)) AS latest
     FROM smart_money_swaps
     WHERE chain = {chain:String} AND block_time >= toDateTime({windowStart:UInt32})
     GROUP BY wallet`,
    { chain, windowStart }
  )
  const fetchedThrough = new Map(latestRows.map((row) => [row.wallet, Number(row.latest)]))
  const fetchedAt = formatDate(Math.floor(Date.now() / 1000))
  const rows: Record<string, unknown>[] = []
  let fetched = 0
  let skipped = 0

  for (const { wallet } of wallets) {
    const latest = fetchedThrough.get(wallet)
    try {
      if (latest !== undefined) {
        const lastActivity = await getLastActivityTime(wallet)
        if (lastActivity !== null && lastActivity <= latest) {
          skipped++
          continue
        }
      }
      // Overlap by a minute so swaps sharing the last stored second are not missed. The table
      // deduplicates on transaction and instruction.
      const since = latest !== undefined ? Math.max(windowStart, latest - 60) : windowStart
      const swaps = await getWalletSwapsSince(wallet, since, config.worker.smartMoneyMaxSwapPages)
      fetched++
      for (const swap of swaps) {
        rows.push({
          chain,
          wallet,
          tx_hash: swap.txHash,
          ins_index: swap.insIndex,
          inner_ins_index: swap.innerInsIndex,
          block_time: formatDate(swap.blockTime),
          volume_usd: swap.volumeUsd,
          base_address: swap.base.address,
          base_symbol: swap.base.symbol,
          base_change: swap.base.uiChangeAmount,
          quote_address: swap.quote.address,
          quote_symbol: swap.quote.symbol,
          quote_change: swap.quote.uiChangeAmount,
          fetched_at: fetchedAt,
        })
      }
    } catch (error) {
      console.warn(`[smart-money] Swaps unavailable for ${wallet}:`, error)
    }
  }

  for (let index = 0; index < rows.length; index += 10_000) {
    await insertClickhouse('smart_money_swaps', rows.slice(index, index + 10_000))
  }
  return { fetched, skipped, stored: rows.length }
}

/** Per-wallet token flows across the window, from the stored swaps. */
async function loadWalletFlows(
  chain: string,
  wallets: TrackedWallet[],
  windowStart: number
): Promise<Map<string, Map<string, TokenFlow>>> {
  const stored = await queryClickhouse<StoredSwap>(
    `SELECT wallet, toUnixTimestamp(block_time) AS block_time, volume_usd, base_address, base_symbol,
            base_change, quote_address, quote_symbol, quote_change
     FROM smart_money_swaps FINAL
     WHERE chain = {chain:String}
       AND block_time >= toDateTime({windowStart:UInt32})
       AND wallet IN {wallets:Array(String)}`,
    { chain, windowStart, wallets: wallets.map((w) => w.wallet) }
  )
  const byWallet = new Map<string, Swap[]>()
  for (const row of stored) {
    const swaps = byWallet.get(row.wallet) ?? []
    swaps.push({
      blockTime: Number(row.block_time),
      volumeUsd: Number(row.volume_usd),
      base: { address: row.base_address, symbol: row.base_symbol, uiChangeAmount: Number(row.base_change) },
      quote: { address: row.quote_address, symbol: row.quote_symbol, uiChangeAmount: Number(row.quote_change) },
    })
    byWallet.set(row.wallet, swaps)
  }
  const flows = new Map<string, Map<string, TokenFlow>>()
  for (const [wallet, swaps] of byWallet) flows.set(wallet, summarizeWalletFlows(swaps))
  return flows
}

export async function syncSmartMoneyBuys(chain: string): Promise<void> {
  if (chain !== 'solana') return
  if (!config.birdeye.apiKey) {
    console.warn('[smart-money] BIRDEYE_API_KEY not set, skipping')
    return
  }

  await refreshLeaderboardIfStale(chain)

  // The latest leaderboard refresh defines the tracked set. Wallets that fell off keep old rows.
  const wallets = await queryClickhouse<TrackedWallet>(
    `SELECT wallet, rank, realized_pnl_30d FROM smart_money_wallets FINAL
     WHERE chain = {chain:String}
       AND updated_at = (SELECT max(updated_at) FROM smart_money_wallets WHERE chain = {chain:String})
     ORDER BY rank`,
    { chain }
  )
  if (wallets.length === 0) return

  const now = Math.floor(Date.now() / 1000)
  const windowStart = now - config.worker.smartMoneyBuyWindowHours * 3600
  const { fetched, skipped, stored } = await fetchNewSwaps(chain, wallets, windowStart)
  const walletFlows = await loadWalletFlows(chain, wallets, windowStart)

  const walletProfit = new Map(wallets.map((w) => [w.wallet, Number(w.realized_pnl_30d)]))
  const candidates = aggregateBuying(walletFlows, config.worker.smartMoneyMinNetBuyUsd, walletProfit)
  const markets = await getSolanaTokenMarketHealth(candidates.map((token) => token.contract))
  const buying = candidates.filter(
    (token) => (markets.get(token.contract)?.liquidity ?? 0) >= config.worker.smartMoneyMinLiquidity
  )
  if (buying.length === 0) {
    console.log(`[smart-money] ${wallets.length} wallets checked, none are net buying a liquid token`)
    return
  }

  // Birdeye's metadata endpoint needs a paid plan, so names and logos come from Dexscreener.
  const metadata = await getSolanaTokenInfo(buying.map((token) => token.contract))

  const snapshotAt = formatDate(now)
  await insertClickhouse(
    'smart_money_buys',
    buying.map((token) => {
      const market = markets.get(token.contract)
      const meta = metadata.get(token.contract)
      return {
        snapshot_at: snapshotAt,
        chain,
        contract: token.contract,
        symbol: meta?.symbol || token.symbol,
        name: meta?.name || token.symbol,
        image_url: meta?.imageUrl ?? '',
        wallet_count: token.walletCount,
        buy_usd: token.buyUsd,
        sell_usd: token.sellUsd,
        net_buy_usd: token.netBuyUsd,
        buy_count: token.buyCount,
        wallets: token.wallets.map((w) => w.wallet),
        wallet_net_buy_usd: token.wallets.map((w) => w.netBuyUsd),
        wallet_last_buy_at: token.wallets.map((w) => formatDate(w.lastBuyAt)),
        first_buy_at: formatDate(token.firstBuyAt),
        last_buy_at: formatDate(token.lastBuyAt),
        price: market?.price ?? 0,
        market_cap: market?.marketCap ?? 0,
        liquidity: market?.liquidity ?? 0,
        volume_24h: market?.volume24h ?? 0,
        price_change_24h: market?.priceChange24h ?? 0,
        buyer_realized_pnl_30d: token.buyerRealizedPnl,
      }
    })
  )

  // The page caches until the next scheduled run, so drop it once fresh data is written.
  await cacheDeletePattern(`*:smart-money:*`)

  const top = buying
    .slice(0, 5)
    .map((token) => `${metadata.get(token.contract)?.symbol || token.symbol}(${token.walletCount})`)
    .join(' ')
  console.log(
    `[smart-money] ${wallets.length} wallets: ${fetched} fetched (${stored} new swaps), ${skipped} unchanged. ` +
      `${buying.length} liquid tokens being bought ` +
      `(${candidates.length - buying.length} illiquid dropped): ${top}`
  )
}

export async function syncAllSmartMoneyBuys(): Promise<void> {
  for (const chain of config.worker.syncChains) {
    try {
      await syncSmartMoneyBuys(chain)
    } catch (error) {
      console.error(`[smart-money] Failed ${chain}:`, error)
    }
  }
}
