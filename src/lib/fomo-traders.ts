import traderFile from '../data/fomo-top-traders.json'

/**
 * The smart money wallet list: FOMO's top traders, with their wallets, saved by
 * scripts/refresh-fomo-traders.ts. They are real, named traders, which the Birdeye leaderboard
 * could not guarantee: it surfaced token deployers, clone farms and bots that needed layers of
 * filtering and still let some through.
 */

export interface FomoTrader {
  rank: number
  userId: string
  handle: string
  displayName: string
  avatar: string
  pnl30dUsd: number | null
  pnl7dUsd: number | null
  pnlAllUsd: number | null
  volumeUsd: number
  trades: number
  followers: number
  wallets: { solana: string | null; evm: string | null }
}

export interface FomoTraderFile {
  generatedAt: string
  source: string
  traders: FomoTrader[]
}

const file = traderFile as FomoTraderFile

/** The refresh is manual, so warn when the saved list is older than this. */
const STALE_AFTER_DAYS = 35

export function fomoTraderList(): FomoTraderFile {
  return file
}

export function fomoListAgeDays(now = Date.now()): number {
  return (now - Date.parse(file.generatedAt)) / 86_400_000
}

export function isFomoListStale(now = Date.now()): boolean {
  return fomoListAgeDays(now) > STALE_AFTER_DAYS
}

/** The wallet each trader uses on a chain. Every other chain is EVM, so it uses the EVM wallet. */
export function walletForChain(trader: FomoTrader, chain: string): string | null {
  return chain === 'solana' ? trader.wallets.solana : trader.wallets.evm
}
