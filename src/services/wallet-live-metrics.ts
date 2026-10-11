import { fomoTraderList } from '../lib/fomo-traders'
import { getEvmNativeBalances } from './alchemy'
import { getWalletPnlSummary, getWalletPortfolio } from './birdeye'
import { getTokenQuotes } from './dexscreener'
import { getLastActivityTimes } from './helius'
import { cacheGet, cacheSet } from './redis'

/**
 * Live balance, 7-day PnL and win rate for watchlist wallets, whichever page they were added
 * from. The old source, wallet_analytics, only covered wallets the retired Birdeye leaderboard
 * pipeline had scored, so wallets added from the smart money page showed no data.
 *
 * Solana comes from Birdeye. Birdeye has no net worth for Robinhood Chain and sees no swaps for
 * FOMO wallets there (FOMO submits them through a relayer), so the EVM chains use the wallet's
 * native balance (ETH or BNB) and FOMO's own 7-day PnL, with no win rate.
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
/** Wrapped native coin per EVM chain, priced on Dexscreener to value the native balance. */
const WRAPPED_NATIVE: Record<string, string> = {
  robinhood: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', // WETH
  bsc: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB
}

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

async function solanaMetrics(
  address: string,
  lastActivity: number | null
): Promise<Omit<LiveWalletMetrics, 'handle' | 'displayName' | 'avatarUrl'>> {
  const [pnl, portfolio] = await Promise.all([
    getWalletPnlSummary(address, '7d').catch(() => null),
    getWalletPortfolio(address).catch(() => null),
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
  const cached = await Promise.all(
    addresses.map((address) => cacheGet<LiveWalletMetrics>(`watchlist:wallet:v1:${chain}:${address}`))
  )
  const missing: string[] = []
  addresses.forEach((address, index) => {
    const hit = cached[index]
    if (hit) result.set(address, hit)
    else missing.push(address)
  })
  if (missing.length === 0) return result

  let nativeBalances = new Map<string, number>()
  let nativePrice = 0
  const wrapped = WRAPPED_NATIVE[chain]
  if (wrapped) {
    const [balances, quotes] = await Promise.all([
      getEvmNativeBalances(chain, missing).catch(() => new Map<string, number>()),
      getTokenQuotes(chain, [wrapped]).catch(() => new Map()),
    ])
    nativeBalances = balances
    nativePrice = quotes.get(wrapped)?.price ?? 0
  }

  // One batched Helius call for every wallet. Per-wallet calls each waited on the shared
  // 750ms Helius throttle, so the page took most of a second per wallet.
  const lastActivity =
    chain === 'solana'
      ? await getLastActivityTimes(missing).catch(() => new Map<string, number>())
      : new Map<string, number>()

  // Wallets load concurrently. Birdeye's own throttle still spaces the calls out.
  await Promise.all(
    missing.map(async (address) => {
      const trader = identity.get(address.toLowerCase())
      const measured =
        chain === 'solana'
          ? await solanaMetrics(address, lastActivity.get(address) ?? null)
          : {
              balance: nativeBalances.has(address) && nativePrice > 0 ? nativeBalances.get(address)! * nativePrice : null,
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
    })
  )
  return result
}
