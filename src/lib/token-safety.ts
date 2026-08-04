/**
 * Layer 1 of alpha scoring v2: hard safety gates that exclude scam and rug-prone tokens.
 *
 * These run before any scoring. A token that trips a gate is dropped from the ranked list and
 * keeps its reasons in risk_flags, so the filters stay auditable instead of silently discarding
 * rows. Every input comes from token_market_health or wallet_token_trades — no extra API calls.
 */

export interface TokenSafetyInput {
  /** Live DexScreener market health. */
  liquidity: number
  marketCap: number
  fdv: number
  volume24h: number
  pairCount: number
  marketHealthy: boolean
  marketHealthFresh: boolean
  /** Trade-derived demand shape; omit when no trade evidence exists. */
  distinctBuyers?: number
  distinctSellers?: number
  /** Share of buy USD landing inside the sniper window after launch, 0-1. */
  sniperShare?: number
  /** Share of buy USD held by the top 3 wallets, 0-1. */
  topBuyerShare?: number
  /** Share of trades flagged as genuine wash/self-trades, 0-1. */
  washRatio?: number
}

export interface TokenSafetyThresholds {
  minLiquidityRatio: number
  maxVolumeToLiquidity: number
  minBuyersForChurn: number
  maxSniperShare: number
  maxTopBuyerShare: number
  maxWashRatio: number
  minSellerRatio: number
  minBuyersForHoneypot: number
  maxFdvRatio: number
  thinPairLiquidity: number
}

export const DEFAULT_SAFETY_THRESHOLDS: TokenSafetyThresholds = {
  /** Liquidity under 2% of market cap means the float cannot exit at quoted prices. */
  minLiquidityRatio: 0.02,
  /** Volume many multiples of liquidity, with few buyers, is churn rather than demand. */
  maxVolumeToLiquidity: 25,
  minBuyersForChurn: 20,
  /** A launch where snipers took most of the buy side is a distribution event, not demand. */
  maxSniperShare: 0.5,
  maxTopBuyerShare: 0.7,
  maxWashRatio: 0.35,
  /** Buyers piling in with almost nobody able to sell is the classic honeypot shape. */
  minSellerRatio: 0.05,
  minBuyersForHoneypot: 50,
  /** FDV far above market cap means a large unlock overhang. */
  maxFdvRatio: 5,
  thinPairLiquidity: 25_000,
}

export interface TokenSafetyResult {
  safe: boolean
  riskFlags: string[]
}

/**
 * Evaluates hard safety gates. Trade-derived checks are skipped when the corresponding input is
 * undefined, so market-health-only ("partial") tokens are judged on what is actually known about
 * them rather than being failed for missing evidence.
 */
export function evaluateTokenSafety(
  input: TokenSafetyInput,
  thresholds: Partial<TokenSafetyThresholds> = {}
): TokenSafetyResult {
  const t = { ...DEFAULT_SAFETY_THRESHOLDS, ...thresholds }
  const riskFlags: string[] = []

  if (!input.marketHealthy) riskFlags.push('unhealthy_market')
  if (!input.marketHealthFresh) riskFlags.push('stale_market_health')

  if (input.marketCap > 0 && input.liquidity / input.marketCap < t.minLiquidityRatio) {
    riskFlags.push('low_liquidity_ratio')
  }

  if (input.pairCount <= 1 && input.liquidity < t.thinPairLiquidity) {
    riskFlags.push('single_thin_pair')
  }

  if (input.marketCap > 0 && input.fdv / input.marketCap > t.maxFdvRatio) {
    riskFlags.push('fdv_overhang')
  }

  // Churn only counts as wash when volume is extreme *and* the buyer set is small; a genuinely
  // busy token with many participants can legitimately turn over its liquidity many times.
  if (
    input.liquidity > 0 &&
    input.volume24h / input.liquidity > t.maxVolumeToLiquidity &&
    input.distinctBuyers !== undefined &&
    input.distinctBuyers < t.minBuyersForChurn
  ) {
    riskFlags.push('wash_volume')
  }

  if (input.sniperShare !== undefined && input.sniperShare > t.maxSniperShare) {
    riskFlags.push('sniper_dominated')
  }

  if (input.topBuyerShare !== undefined && input.topBuyerShare > t.maxTopBuyerShare) {
    riskFlags.push('buyer_concentration')
  }

  if (input.washRatio !== undefined && input.washRatio > t.maxWashRatio) {
    riskFlags.push('wash_trading')
  }

  if (
    input.distinctBuyers !== undefined &&
    input.distinctSellers !== undefined &&
    input.distinctBuyers >= t.minBuyersForHoneypot &&
    input.distinctSellers / Math.max(input.distinctBuyers, 1) < t.minSellerRatio
  ) {
    riskFlags.push('honeypot_risk')
  }

  return { safe: riskFlags.length === 0, riskFlags }
}
