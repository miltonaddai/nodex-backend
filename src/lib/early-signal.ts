/**
 * The "early signal" preset on the wallets page.
 *
 * From a backtest of 432 Solana tokens that top traders bought below $100K (one week of
 * snapshots, early October 2026): 2% went on to 5x or more. Tokens meeting all of the
 * conditions below did 9% (3 of 35: Agency 86x, BAGSPAY 21x, Pygoscelis 13x). The sample is
 * small, so treat this as a lead, not a proven edge, and revisit it as history accumulates.
 */
export const EARLY_SIGNAL = {
  maxMarketCap: 100_000,
  minTraders: 2,
  /** 24h volume at least this many times market cap: heavy trading for the token's size. */
  minVolumeToMarketCap: 10,
  /** Tracked traders have sold less than this share of what they bought: holding, not flipping. */
  maxSellRatio: 0.3,
} as const

export interface EarlySignalInput {
  marketCap: number
  liquidity: number
  volume24h: number
  walletCount: number
  buyUsd: number
  sellUsd: number
}

/**
 * True when a token meets every early-signal condition. A market cap below a third of liquidity
 * is a misreported figure (bridged tokens), so those never qualify.
 */
export function isEarlySignal(token: EarlySignalInput): boolean {
  const { marketCap, liquidity, volume24h, walletCount, buyUsd, sellUsd } = token
  if (!(marketCap > 0) || marketCap > EARLY_SIGNAL.maxMarketCap) return false
  if (liquidity > marketCap * 3) return false
  if (walletCount < EARLY_SIGNAL.minTraders) return false
  if (volume24h < marketCap * EARLY_SIGNAL.minVolumeToMarketCap) return false
  return buyUsd > 0 && sellUsd / buyUsd < EARLY_SIGNAL.maxSellRatio
}
