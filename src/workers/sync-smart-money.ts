import { config } from '../config'
import { fomoListAgeDays, fomoTraderList, isFomoListStale, walletForChain } from '../lib/fomo-traders'
import { aggregateBuying, summarizeWalletFlows, type Swap, type TokenFlow } from '../lib/smart-money'
import { getWalletSwapsSince } from '../services/birdeye'
import { insertClickhouse, queryClickhouse } from '../services/clickhouse'
import { getTokenInfo, getTokenMarketHealth } from '../services/dexscreener'
import { getFomoAlerts } from '../services/fomo'
import { getLastActivityTime } from '../services/helius'
import { cacheDeletePattern } from '../services/redis'

/**
 * Smart money: tokens the top FOMO traders are net buying now.
 *
 * The wallets come from FOMO's leaderboards, saved monthly to src/data/fomo-top-traders.json.
 * They belong to named traders, so none of the Birdeye-era filtering for deployers, clone farms
 * and bots is needed. What they are buying is refreshed every run, for Solana (their Solana
 * wallets) and Robinhood Chain (their EVM wallets).
 */
export const SMART_MONEY_CHAINS = new Set(['solana', 'robinhood'])

interface TrackedWallet {
  wallet: string
  rank: number
  realized_pnl_30d: number
}

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace('T', ' ').slice(0, 19)
}

/**
 * Writes the saved FOMO list into smart_money_wallets for one chain. Skipped when the table
 * already holds this version of the list, so it only does work after a monthly refresh.
 */
export async function syncTrackedWallets(chain: string, force = false): Promise<void> {
  const list = fomoTraderList()
  const version = `fomo:${list.generatedAt}`
  if (isFomoListStale()) {
    console.warn(
      `[smart-money ${chain}] FOMO trader list is ${Math.floor(fomoListAgeDays())} days old. ` +
        'Run npm run fomo:refresh, commit src/data/fomo-top-traders.json and redeploy.'
    )
  }

  const [current] = await queryClickhouse<{ source: string }>(
    `SELECT any(source) AS source FROM smart_money_wallets
     WHERE chain = {chain:String}
       AND updated_at = (SELECT max(updated_at) FROM smart_money_wallets WHERE chain = {chain:String})`,
    { chain }
  )
  if (!force && current?.source === version) return

  const traders = list.traders.filter((trader) => walletForChain(trader, chain))
  if (traders.length === 0) {
    console.warn(`[smart-money ${chain}] FOMO trader list has no wallets for this chain; keeping the previous list`)
    return
  }
  const updatedAt = formatDate(Math.floor(Date.now() / 1000))
  await insertClickhouse(
    'smart_money_wallets',
    traders.map((trader) => ({
      wallet: walletForChain(trader, chain),
      chain,
      rank: trader.rank,
      // FOMO reports total PnL without a realized split. Traders only on the 7-day, all-time or
      // 24-hour boards have no 30-day figure.
      pnl_30d: trader.pnl30dUsd ?? 0,
      realized_pnl_30d: trader.pnl30dUsd ?? 0,
      volume_30d: trader.volumeUsd,
      trades_30d: Math.round(trader.trades),
      handle: trader.handle,
      display_name: trader.displayName,
      avatar_url: trader.avatar,
      followers: Math.round(trader.followers),
      source: version,
      updated_at: updatedAt,
    }))
  )
  console.log(`[smart-money ${chain}] Tracking ${traders.length} FOMO traders from the list saved ${list.generatedAt}`)
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

/** Placeholder quote side for feed trades: FOMO reports the USD value, not what was paid with. */
const FEED_QUOTE = { address: '0x0000000000000000000000000000000000000000', symbol: 'ETH' }

/**
 * The feed returns the newest events first and holds roughly the latest 200 per filter (about
 * 7 hours of Robinhood Chain buys), so a run every 2 hours reads everything since the last one.
 */
const FEED_PAGE = 200

/**
 * Stores tracked traders' Robinhood Chain trades from FOMO's feed. FOMO submits these trades
 * through a relayer, so the trader's wallet never sends the swap and Birdeye's per-wallet swap
 * history shows almost nothing (1 of 212 wallets had a swap in 72 hours). The feed reports each
 * trade by trader, with its USD value. One buy and one sell call per run, 250 credits.
 */
async function fetchFeedSwaps(
  chain: string,
  wallets: TrackedWallet[],
  windowStart: number
): Promise<{ fetched: number; skipped: number; stored: number }> {
  const tracked = new Set(wallets.map((w) => w.wallet.toLowerCase()))
  const walletByUser = new Map<string, string>()
  for (const trader of fomoTraderList().traders) {
    const wallet = walletForChain(trader, chain)
    if (wallet && tracked.has(wallet.toLowerCase())) walletByUser.set(trader.userId, wallet)
  }

  const fetchedAt = formatDate(Math.floor(Date.now() / 1000))
  const rows: Record<string, unknown>[] = []
  let fetched = 0
  for (const type of ['buy', 'sell'] as const) {
    // No `since`: the feed only holds its newest page, and stored rows deduplicate on event id,
    // so reading the whole page each run is both complete and safe to repeat.
    const alerts = (await getFomoAlerts({ type, chain, limit: FEED_PAGE })).filter(
      (alert) => alert.ts >= windowStart * 1000
    )
    // Events are only lost if one page spans less time than the gap between runs.
    const oldest = Math.min(...alerts.map((alert) => alert.ts))
    const runGapMs = config.worker.tokenSyncIntervalMinutes * 60_000
    if (alerts.length >= FEED_PAGE && oldest > Date.now() - runGapMs) {
      console.warn(`[smart-money ${chain}] FOMO ${type} feed covers less than one run interval; some ${type}s were missed`)
    }
    for (const alert of alerts) {
      const wallet = walletByUser.get(alert.userId)
      if (!wallet || !alert.tokenAddress || !alert.ts) continue
      fetched++
      const sign = type === 'buy' ? 1 : -1
      rows.push({
        chain,
        wallet,
        tx_hash: alert.eventId,
        ins_index: 0,
        inner_ins_index: 0,
        block_time: formatDate(Math.floor(alert.ts / 1000)),
        // Some sell events carry a negative value. The direction is already in the sign above.
        volume_usd: Math.abs(Number(alert.usdValue ?? 0)),
        base_address: alert.tokenAddress,
        base_symbol: alert.token ?? '',
        base_change: sign,
        quote_address: FEED_QUOTE.address,
        quote_symbol: FEED_QUOTE.symbol,
        quote_change: -sign,
        fetched_at: fetchedAt,
      })
    }
  }
  if (rows.length > 0) await insertClickhouse('smart_money_swaps', rows)
  return { fetched, skipped: 0, stored: rows.length }
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
      // Only Solana has a cheap "anything new?" check. On Robinhood Chain the equivalent Alchemy
      // call costs more than the Birdeye fetch it would save.
      if (latest !== undefined && chain === 'solana') {
        const lastActivity = await getLastActivityTime(wallet)
        if (lastActivity !== null && lastActivity <= latest) {
          skipped++
          continue
        }
      }
      // Overlap by a minute so swaps sharing the last stored second are not missed. The table
      // deduplicates on transaction and instruction.
      const since = latest !== undefined ? Math.max(windowStart, latest - 60) : windowStart
      const swaps = await getWalletSwapsSince(wallet, since, config.worker.smartMoneyMaxSwapPages, chain)
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
      console.warn(`[smart-money ${chain}] Swaps unavailable for ${wallet}:`, error)
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
  for (const [wallet, swaps] of byWallet) flows.set(wallet, summarizeWalletFlows(swaps, chain))
  return flows
}

export async function syncSmartMoneyBuys(chain: string): Promise<void> {
  if (!SMART_MONEY_CHAINS.has(chain)) return
  if (chain === 'robinhood' && !config.fomo.apiKey) {
    console.warn('[smart-money robinhood] FOMO_API_KEY not set, skipping Robinhood Chain')
    return
  }
  if (!config.birdeye.apiKey) {
    console.warn('[smart-money] BIRDEYE_API_KEY not set, skipping')
    return
  }

  await syncTrackedWallets(chain)

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
  // Robinhood Chain trades go through FOMO's relayer, so they come from FOMO's feed instead.
  const { fetched, skipped, stored } =
    chain === 'robinhood'
      ? await fetchFeedSwaps(chain, wallets, windowStart)
      : await fetchNewSwaps(chain, wallets, windowStart)
  const walletFlows = await loadWalletFlows(chain, wallets, windowStart)

  const walletProfit = new Map(wallets.map((w) => [w.wallet, Number(w.realized_pnl_30d)]))
  const candidates = aggregateBuying(walletFlows, config.worker.smartMoneyMinNetBuyUsd, walletProfit)
  const markets = await getTokenMarketHealth(chain, candidates.map((token) => token.contract))
  const buying = candidates.filter(
    (token) => (markets.get(token.contract)?.liquidity ?? 0) >= config.worker.smartMoneyMinLiquidity
  )
  if (buying.length === 0) {
    console.log(`[smart-money ${chain}] ${wallets.length} wallets checked, none are net buying a liquid token`)
    return
  }

  // Birdeye's metadata endpoint needs a paid plan, so names and logos come from Dexscreener.
  const metadata = await getTokenInfo(chain, buying.map((token) => token.contract))

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
    `[smart-money ${chain}] ${wallets.length} wallets: ${fetched} fetched (${stored} new swaps), ${skipped} unchanged. ` +
      `${buying.length} liquid tokens being bought ` +
      `(${candidates.length - buying.length} illiquid dropped): ${top}`
  )
}

export async function syncAllSmartMoneyBuys(): Promise<void> {
  for (const chain of config.worker.syncChains) {
    try {
      await syncSmartMoneyBuys(chain)
    } catch (error) {
      console.error(`[smart-money ${chain}] Failed ${chain}:`, error)
    }
  }
}
