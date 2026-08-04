import { config } from '../config'

const SUSPICIOUS_TAGS = new Set(['dev', 'bundler', 'insider', 'sniper'])

export interface WalletFreshnessInput {
  tags: string[]
  fundingUnixTime: number
  firstObservedAt: number
  distinctTokenCount: number
  now?: number
  freshWalletDays?: number
}

export function normalizeTraderTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.toLowerCase()).filter(Boolean))]
}

export function hasSuspiciousTraderTag(tags: string[]): boolean {
  return normalizeTraderTags(tags).some((tag) => SUSPICIOUS_TAGS.has(tag))
}

export function isFreshWallet(input: WalletFreshnessInput): boolean {
  const now = input.now ?? Math.floor(Date.now() / 1000)
  const freshWindowSeconds = (input.freshWalletDays ?? config.worker.alphaFreshWalletDays) * 86_400
  const tags = normalizeTraderTags(input.tags)

  if (tags.includes('fresh')) return true
  if (input.fundingUnixTime > 0 && now - input.fundingUnixTime <= freshWindowSeconds) return true
  if (
    input.firstObservedAt > 0 &&
    now - input.firstObservedAt <= freshWindowSeconds &&
    input.distinctTokenCount <= 1
  ) {
    return true
  }
  return false
}

export interface RealBuyerInput {
  tags: string[]
  netFlowUsd: number
  isFresh: boolean
  /** True when the wallet's first buy landed inside the sniper window after launch. */
  isSniper: boolean
  /** Distinct other tokens this wallet has traded; separates real participants from burners. */
  distinctOtherTokens: number
  /** Share of this wallet's trades on the token flagged as wash/self-trades, 0-1. */
  washRatio: number
  minPositionUsd?: number
  maxWashRatio?: number
}

/**
 * A "real buyer": a wallet genuinely accumulating the token, as opposed to a sniper, a wash
 * trader, or a burner wallet spun up for one launch.
 *
 * Note what this deliberately does NOT check: wallet reputation. v1 required buyers to clear a
 * `smart_score` threshold that was itself computed from realized profit (i.e. from selling),
 * which meant no net buyer could ever qualify. Reputation is applied separately as a weight on
 * inflow, never as an eligibility gate.
 */
export function isRealBuyer(input: RealBuyerInput): boolean {
  const minPositionUsd = input.minPositionUsd ?? 0
  const maxWashRatio = input.maxWashRatio ?? 0.5
  // A buyer must be net-accumulating. The dollar floor is deliberately 0 by default: genuine
  // retail on new launches usually nets well under $10, and a $50 floor excluded so many real
  // participants that no token could reach a credible buyer count.
  if (input.netFlowUsd <= 0) return false
  if (minPositionUsd > 0 && input.netFlowUsd < minPositionUsd) return false
  if (hasSuspiciousTraderTag(input.tags)) return false
  if (input.isFresh) return false
  if (input.isSniper) return false
  if (input.washRatio > maxWashRatio) return false
  return true
}

/** An independent buyer is a real buyer with a trading history beyond this one token. */
export function isIndependentBuyer(input: RealBuyerInput, minOtherTokens = 2): boolean {
  return isRealBuyer(input) && input.distinctOtherTokens >= minOtherTokens
}
