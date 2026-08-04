export interface TradeForPerformance {
  side: 'buy' | 'sell'
  tokenAmount: number
  quoteUsd: number
  blockTime: number
  minutesAfterLaunch: number
  suspicious: boolean
}

export interface TokenPerformance {
  contract: string
  launchedAt: number
  firstBuyAt: number
  lastTradeAt: number
  entryDelayMinutes: number
  buyUsd: number
  sellUsd: number
  boughtAmount: number
  soldAmount: number
  remainingAmount: number
  realizedPnl: number
  unrealizedPnl: number
  roiPct: number
  tradeCount: number
  suspiciousTradeCount: number
}

export interface WalletScore {
  smartScore: number
  wins: number
  medianRoiPct: number
  avgEntryDelayMinutes: number
  realizedProfit: number
  unrealizedProfit: number
  concentrationPct: number
  riskFlags: string[]
  eligible: boolean
}

export type EvidenceTier = 'verified' | 'partial' | 'unverified'

/**
 * Demand shape derived from raw wallet_token_trades. All of this describes the *current* token:
 * who is accumulating it right now, how concentrated that is, and whether it persisted.
 * Deliberately independent of wallet reputation, which describes past exits.
 */
export interface TokenDemandInput {
  /** Distinct wallets net-accumulating above the minimum position size. */
  realBuyers: number
  /** Real buyers that have also traded other tokens (filters single-purpose burner wallets). */
  independentBuyers: number
  netInflowUsd: number
  /** Net inflow weighted by each buyer's out-of-sample reputation score. */
  reputationWeightedInflow: number
  /** Share of real buyers still holding, 0-1. */
  retentionRate: number
  /** Share of time buckets with real buy pressure, 0-1. */
  demandPersistence: number
  /** Share of buy USD from the top 3 wallets, 0-1. */
  topBuyerShare: number
  /** Share of buy USD inside the sniper window, 0-1. */
  sniperShare: number
  /** Share of trades flagged as genuine wash/self-trades, 0-1. */
  washRatio: number
  /** Share of real buyers that are fresh wallets, 0-1. */
  freshBuyerShare: number
  /** Top holders sampled for wealth, and how many cleared the wealth threshold. */
  enrichedHolders: number
  wealthyHolders: number
}

export interface TokenScoreInput {
  ageDays: number
  liquidity: number
  marketCap: number
  evidenceTier: EvidenceTier
  /** True when a Layer 1 safety gate tripped; forces a zero score. */
  safetyFailed: boolean
  demand: TokenDemandInput
  buyAcceleration: number
  /** Hard floor on real buyers. Tokens below it are excluded outright, not merely penalized. */
  minRealBuyers?: number
  minWealthyHolders?: number
  /** Minimum share of real buyers that must have traded other tokens, 0-1. */
  minIndependentShare?: number
  /** Ceiling on market cap carried per real buyer. */
  maxMcapPerBuyer?: number
}

export interface TokenScore {
  alphaScore: number
  riskFlags: string[]
  /** Scored means a real, comparable alpha_score was produced (verified + safe + enough buyers). */
  scored: boolean
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function wilsonLowerBound(wins: number, total: number): number {
  if (total === 0) return 0
  const z = 1.2816
  const p = wins / total
  const denominator = 1 + (z * z) / total
  const centre = p + (z * z) / (2 * total)
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total)
  return (centre - margin) / denominator
}

export function aggregateTokenPerformance(
  contract: string,
  launchedAt: number,
  currentPrice: number,
  trades: TradeForPerformance[]
): TokenPerformance | null {
  const sorted = trades.filter((trade) => trade.tokenAmount > 0 && trade.quoteUsd > 0).sort((a, b) => a.blockTime - b.blockTime)
  const buys = sorted.filter((trade) => trade.side === 'buy')
  if (buys.length === 0) return null

  const buyUsd = buys.reduce((sum, trade) => sum + trade.quoteUsd, 0)
  const sellUsd = sorted.filter((trade) => trade.side === 'sell').reduce((sum, trade) => sum + trade.quoteUsd, 0)
  const boughtAmount = buys.reduce((sum, trade) => sum + trade.tokenAmount, 0)
  const soldAmountRaw = sorted.filter((trade) => trade.side === 'sell').reduce((sum, trade) => sum + trade.tokenAmount, 0)
  const soldAmount = Math.min(soldAmountRaw, boughtAmount)
  const remainingAmount = Math.max(0, boughtAmount - soldAmount)
  const averageCost = boughtAmount > 0 ? buyUsd / boughtAmount : 0
  const realizedPnl = sellUsd - averageCost * soldAmount
  const unrealizedPnl = remainingAmount * currentPrice - averageCost * remainingAmount
  const roiPct = buyUsd > 0 ? ((realizedPnl + unrealizedPnl) / buyUsd) * 100 : 0

  return {
    contract,
    launchedAt,
    firstBuyAt: buys[0].blockTime,
    lastTradeAt: sorted[sorted.length - 1].blockTime,
    entryDelayMinutes: Math.max(0, buys[0].minutesAfterLaunch),
    buyUsd,
    sellUsd,
    boughtAmount,
    soldAmount,
    remainingAmount,
    realizedPnl,
    unrealizedPnl,
    roiPct: clamp(roiPct, -100, 1000),
    tradeCount: sorted.length,
    suspiciousTradeCount: sorted.filter((trade) => trade.suspicious).length,
  }
}

export function scoreWallet(
  performances: TokenPerformance[],
  minDistinctTokens: number,
  minPeriodProfitUsd = 100,
  minPeriodTrades = 5
): WalletScore {
  const clean = performances.filter((item) => item.buyUsd > 0)
  const wins = clean.filter((item) => item.realizedPnl + item.unrealizedPnl > 0).length
  const medianRoiPct = median(clean.map((item) => clamp(item.roiPct, -100, 300)))
  const avgEntryDelayMinutes =
    clean.length > 0 ? clean.reduce((sum, item) => sum + item.entryDelayMinutes, 0) / clean.length : 0
  const realizedProfit = clean.reduce((sum, item) => sum + item.realizedPnl, 0)
  const unrealizedProfit = clean.reduce((sum, item) => sum + item.unrealizedPnl, 0)
  const totalInvested = clean.reduce((sum, item) => sum + item.buyUsd, 0)
  const largestPosition = clean.reduce((max, item) => Math.max(max, item.buyUsd), 0)
  const concentrationPct = totalInvested > 0 ? (largestPosition / totalInvested) * 100 : 100
  const suspiciousTrades = clean.reduce((sum, item) => sum + item.suspiciousTradeCount, 0)
  const totalTrades = clean.reduce((sum, item) => sum + item.tradeCount, 0)
  const periodProfit = realizedProfit + unrealizedProfit
  const enoughEvidence = clean.length >= minDistinctTokens
  const profitableInPeriod = periodProfit >= minPeriodProfitUsd
  const activeInPeriod = totalTrades >= minPeriodTrades
  const eligible = enoughEvidence && profitableInPeriod && activeInPeriod

  const hitRate = wilsonLowerBound(wins, clean.length)
  const roiQuality = clamp((medianRoiPct + 100) / 400, 0, 1)
  const repeatability = clamp(clean.length / 10, 0, 1)
  const entrySpeed = Math.exp(-avgEntryDelayMinutes / 720)
  const realizedQuality = clamp(realizedProfit / Math.max(totalInvested, 1), 0, 1)
  const activity = clamp(totalTrades / 30, 0, 1)
  const concentrationPenalty = clamp((concentrationPct - 60) / 40, 0, 1) * 15
  const suspiciousPenalty = clamp(suspiciousTrades / Math.max(totalTrades, 1), 0, 1) * 20
  const raw =
    hitRate * 30 +
    roiQuality * 25 +
    repeatability * 15 +
    entrySpeed * 15 +
    realizedQuality * 10 +
    activity * 5 -
    concentrationPenalty -
    suspiciousPenalty

  const riskFlags: string[] = []
  if (concentrationPct > 75) riskFlags.push('high_concentration')
  if (suspiciousTrades / Math.max(totalTrades, 1) > 0.2) riskFlags.push('suspicious_activity')
  if (!enoughEvidence) riskFlags.push('insufficient_evidence')
  if (!profitableInPeriod) riskFlags.push('unprofitable_in_period')
  if (!activeInPeriod) riskFlags.push('inactive_in_period')

  return {
    smartScore: eligible ? clamp(raw, 0, 100) : 0,
    wins,
    medianRoiPct,
    avgEntryDelayMinutes,
    realizedProfit,
    unrealizedProfit,
    concentrationPct,
    riskFlags,
    eligible,
  }
}

/**
 * Reputation from a wallet's CLOSED positions on tokens other than the one being scored.
 *
 * This is the fix for the v1 contradiction. v1 used a single `smart_score` that rewarded realized
 * profit, then demanded the same wallets be net buyers — mutually exclusive, so no wallet ever
 * qualified. Reputation now describes past exits only; whether a wallet is currently accumulating
 * is measured separately in TokenDemandInput. Pass performances excluding the scored token
 * (leave-one-out) so a token can never boost its own buyers' reputation.
 */
export function scoreWalletReputation(
  closedPerformances: TokenPerformance[],
  minClosedPositions = 2
): { reputationScore: number; closedPositions: number; riskFlags: string[] } {
  const clean = closedPerformances.filter((item) => item.buyUsd > 0)
  const riskFlags: string[] = []

  if (clean.length < minClosedPositions) {
    riskFlags.push('insufficient_history')
    return { reputationScore: 0, closedPositions: clean.length, riskFlags }
  }

  const wins = clean.filter((item) => item.realizedPnl + item.unrealizedPnl > 0).length
  const hitRate = wilsonLowerBound(wins, clean.length)
  const medianRoiPct = median(clean.map((item) => clamp(item.roiPct, -100, 300)))
  const roiQuality = clamp((medianRoiPct + 100) / 400, 0, 1)
  const repeatability = clamp(clean.length / 10, 0, 1)
  const avgEntryDelayMinutes =
    clean.reduce((sum, item) => sum + item.entryDelayMinutes, 0) / clean.length
  const entrySpeed = Math.exp(-avgEntryDelayMinutes / 720)
  const totalInvested = clean.reduce((sum, item) => sum + item.buyUsd, 0)
  const realizedProfit = clean.reduce((sum, item) => sum + item.realizedPnl, 0)
  const realizedQuality = clamp(realizedProfit / Math.max(totalInvested, 1), 0, 1)

  const largestPosition = clean.reduce((max, item) => Math.max(max, item.buyUsd), 0)
  const concentrationPct = totalInvested > 0 ? (largestPosition / totalInvested) * 100 : 100
  const concentrationPenalty = clamp((concentrationPct - 60) / 40, 0, 1) * 15
  if (concentrationPct > 75) riskFlags.push('high_concentration')

  const raw =
    hitRate * 35 +
    roiQuality * 25 +
    repeatability * 20 +
    entrySpeed * 10 +
    realizedQuality * 10 -
    concentrationPenalty

  return {
    reputationScore: clamp(raw, 0, 100),
    closedPositions: clean.length,
    riskFlags,
  }
}

/**
 * Layer 4 composite. Unlike v1 there is no AND-gate over market conditions — only an upstream
 * safety failure (Layer 1) or missing evidence (Layer 0) forces a zero, so everything else
 * degrades continuously instead of collapsing to 0.
 */
export function scoreToken(input: TokenScoreInput): TokenScore {
  const d = input.demand
  const minRealBuyers = input.minRealBuyers ?? 100
  const minWealthyHolders = input.minWealthyHolders ?? 0
  const minIndependentShare = input.minIndependentShare ?? 0
  const maxMcapPerBuyer = input.maxMcapPerBuyer ?? Number.POSITIVE_INFINITY
  const independentShare = d.realBuyers > 0 ? d.independentBuyers / d.realBuyers : 0
  const mcapPerBuyer = d.realBuyers > 0 ? input.marketCap / d.realBuyers : Number.POSITIVE_INFINITY
  const riskFlags: string[] = []

  // A valuation this large behind this few buyers is a price without a holder base.
  if (input.marketCap > 0 && mcapPerBuyer > maxMcapPerBuyer) {
    riskFlags.push('mcap_per_buyer_too_high')
  }

  // A broad organic buyer base is the strongest available legitimacy signal. Bundled launches
  // show a handful of buyers against a large market cap, so this is an exclusion, not a penalty.
  if (d.realBuyers < minRealBuyers) riskFlags.push('insufficient_real_buyers')
  if (d.netInflowUsd <= 0) riskFlags.push('net_outflow')
  // Wallet farms show a large buyer count where none of those wallets exist anywhere else.
  // Zero independence is always worth flagging, whatever threshold is configured.
  if (d.realBuyers > 0 && d.independentBuyers === 0) {
    riskFlags.push('only_single_purpose_wallets')
  } else if (d.realBuyers > 0 && independentShare < minIndependentShare) {
    riskFlags.push('low_buyer_independence')
  }
  if (d.enrichedHolders > 0 && d.wealthyHolders === 0) riskFlags.push('no_wealthy_holders')

  // Layer 1 already recorded its own reasons; Layer 0 tiers are recorded by the caller.
  if (input.safetyFailed || input.evidenceTier !== 'verified') {
    return { alphaScore: 0, riskFlags, scored: false }
  }
  if (d.realBuyers < minRealBuyers || d.netInflowUsd <= 0) {
    return { alphaScore: 0, riskFlags, scored: false }
  }
  // Only enforce the wealth bar when holders were actually sampled. Absence of enrichment data
  // is not evidence of a bundle, and failing on it would silently exclude every token that the
  // enrichment step has not reached yet.
  if (minWealthyHolders > 0 && d.enrichedHolders > 0 && d.wealthyHolders < minWealthyHolders) {
    return { alphaScore: 0, riskFlags, scored: false }
  }
  if (independentShare < minIndependentShare) {
    return { alphaScore: 0, riskFlags, scored: false }
  }
  if (input.marketCap > 0 && mcapPerBuyer > maxMcapPerBuyer) {
    return { alphaScore: 0, riskFlags, scored: false }
  }

  const recency = clamp(1 - input.ageDays / 30, 0, 1)
  // Scaled so 100 buyers (the floor) reads as mid-range and ~1000 saturates, keeping the top of
  // the range meaningful now that a broad base is mandatory rather than exceptional.
  const buyerScale = clamp(Math.log1p(d.realBuyers) / Math.log(1_001), 0, 1)
  // Independent buyers carry the breadth signal; raw buyer count is easier to manufacture.
  const buyerBreadth = clamp(Math.log1p(d.independentBuyers) / Math.log(21), 0, 1)
  // Substantial wallets among the largest holders: throwaway wallets holding the top positions
  // is the shape of a bundle.
  const holderWealth =
    d.enrichedHolders > 0 ? clamp(d.wealthyHolders / d.enrichedHolders, 0, 1) : 0
  const netInflow = clamp(Math.log1p(Math.max(d.netInflowUsd, 0)) / Math.log(100_001), 0, 1)
  const reputationQuality =
    d.netInflowUsd > 0 ? clamp(d.reputationWeightedInflow / d.netInflowUsd / 100, 0, 1) : 0
  const retention = clamp(d.retentionRate, 0, 1)
  const persistence = clamp(d.demandPersistence, 0, 1)
  const acceleration = clamp((input.buyAcceleration + 1) / 3, 0, 1)
  const liquidityQuality = clamp(Math.log1p(input.liquidity) / Math.log(250_001), 0, 1)

  const concentrationPenalty = clamp((d.topBuyerShare - 0.4) / 0.6, 0, 1) * 20
  const sniperPenalty = clamp(d.sniperShare / 0.5, 0, 1) * 15
  const washPenalty = clamp(d.washRatio / 0.35, 0, 1) * 15
  const freshPenalty = clamp(d.freshBuyerShare / 0.5, 0, 1) * 10

  const raw =
    buyerScale * 25 +
    holderWealth * 20 +
    buyerBreadth * 12 +
    reputationQuality * 10 +
    netInflow * 10 +
    retention * 10 +
    persistence * 6 +
    recency * 4 +
    acceleration * 2 +
    liquidityQuality * 1 -
    concentrationPenalty -
    sniperPenalty -
    washPenalty -
    freshPenalty

  return { alphaScore: clamp(raw, 0, 100), riskFlags, scored: true }
}
