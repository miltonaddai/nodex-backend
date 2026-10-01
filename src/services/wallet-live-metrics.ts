import { fomoTraderList } from '../lib/fomo-traders'
import { getRobinhoodEthBalances } from './alchemy'
import { getWalletPnlSummary, getWalletPortfolio } from './birdeye'
import { getTokenQuotes } from './dexscreener'
import { getLastActivityTime } from './helius'
import { cacheGet, cacheSet } from './redis'

/**
 * Live balance, 7-day PnL and win rate for watchlist wallets, whichever page they were added
 * from. The old source, wallet_analytics, only covered wallets the retired Birdeye leaderboard
 * pipeline had scored, so wallets added from the smart money page showed no data.
 *
 * Solana comes from Birdeye. Birdeye has no net worth for Robinhood Chain and sees no swaps for
 * FOMO wallets there (FOMO submits them through a relayer), so those use the wallet's ETH balance
 * and FOMO's own 7-day PnL, with no win rate.
 */

export interface LiveWalletMetrics {
  balance: number | null
  pnl7d: number | null
  /** Percent, 0-100. */
  winRate: number | null
  lastActive: string | null
  handle: string | null
  displayName: string | null
  avatarUrl: string | null
}

const TTL_SECONDS = 300
const ROBINHOOD_WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'

function formatLastActive(unixSeconds: number | null): string | null {
  if (!unixSeconds) return null
  const minutes = Math.max(1, Math.floor((Date.now() / 1000 - unixSeconds) / 60))
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

function fomoIdentity(chain: string) {
  const map = new Map<string, { handle: string; displayName: string; avatarUrl: string; pnl7dUsd: number | null }>()
  for (const trader of fomoTraderList().traders) {
    const wallet = chain === 'solana' ? trader.wallets.solana : trader.wallets.evm
    if (wallet) {
      map.set(wallet.toLowerCase(), {
        handle: trader.handle,
        displayName: trader.displayName,
        avatarUrl: trader.avatar,
        pnl7dUsd: trader.pnl7dUsd,
      })
    }
  }
  return map
}

async function solanaMetrics(address: string): Promise<Omit<LiveWalletMetrics, 'handle' | 'displayName' | 'avatarUrl'>> {
  const [pnl, portfolio, lastActivity] = await Promise.all([
    getWalletPnlSummary(address, '7d').catch(() => null),
    getWalletPortfolio(address).catch(() => null),
    getLastActivityTime(address).catch(() => null),
  ])
  return {
    balance: portfolio?.totalValueUsd ?? null,
    pnl7d: pnl ? pnl.totalUsd : null,
    // Birdeye reports a fraction, and zero when the wallet closed no trades.
    winRate: pnl && pnl.totalTrades > 0 ? Math.round(pnl.winRate * 100) : null,
    lastActive: formatLastActive(lastActivity),
  }
}

export async function getLiveWalletMetrics(chain: string, addresses: string[]): Promise<Map<string, LiveWalletMetrics>> {
  const result = new Map<string, LiveWalletMetrics>()
  const identity = fomoIdentity(chain)
  const missing: string[] = []
  for (const address of addresses) {
    const cached = await cacheGet<LiveWalletMetrics>(`watchlist:wallet:v1:${chain}:${address}`)
    if (cached) result.set(address, cached)
    else missing.push(address)
  }
  if (missing.length === 0) return result

  let ethBalances = new Map<string, number>()
  let ethPrice = 0
  if (chain === 'robinhood') {
    const [balances, quotes] = await Promise.all([
      getRobinhoodEthBalances(missing).catch(() => new Map<string, number>()),
      getTokenQuotes('robinhood', [ROBINHOOD_WETH]).catch(() => new Map()),
    ])
    ethBalances = balances
    ethPrice = quotes.get(ROBINHOOD_WETH)?.price ?? 0
  }

  for (const address of missing) {
    const trader = identity.get(address.toLowerCase())
    const measured =
      chain === 'solana'
        ? await solanaMetrics(address)
        : {
            balance: ethBalances.has(address) && ethPrice > 0 ? ethBalances.get(address)! * ethPrice : null,
            pnl7d: trader?.pnl7dUsd ?? null,
            winRate: null,
            lastActive: null,
          }
    const metrics: LiveWalletMetrics = {
      ...measured,
      handle: trader?.handle ?? null,
      displayName: trader?.displayName ?? null,
      avatarUrl: trader?.avatarUrl || null,
    }
    result.set(address, metrics)
    await cacheSet(`watchlist:wallet:v1:${chain}:${address}`, metrics, TTL_SECONDS)
  }
  return result
}
