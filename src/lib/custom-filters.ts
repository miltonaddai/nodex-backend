/**
 * User-built filters for the Smart Wallets table: a list of "field at least / at most value" rules
 * that a token must all meet. Rules arrive as JSON in the `rules` query parameter and are checked
 * against the cached snapshot, so a filter never costs a database query.
 *
 * Only the fields below can be filtered on. The frontend keeps the same ids with their labels and
 * units in src/lib/custom-filters.ts.
 */

export interface FilterableBuy {
  walletCount: number
  netBuyUsd: number
  buyUsd: number
  sellUsd: number
  buyCount: number
  marketCap: number
  liquidity: number
  volume24h: number
  priceChange24h: number
  buyerRealizedPnl30d: number
  lastBuyAt: string
  firstSeenAt: string | null
  peakMultiple: number | null
}

const HOUR_MS = 3_600_000

/** How each field is read from a token. Null means the token has no value, and fails the rule. */
export const FILTER_FIELDS: Record<string, (item: FilterableBuy, now: number) => number | null> = {
  walletCount: (item) => item.walletCount,
  netBuyUsd: (item) => item.netBuyUsd,
  buyUsd: (item) => item.buyUsd,
  sellUsd: (item) => item.sellUsd,
  soldPct: (item) => (item.buyUsd > 0 ? (item.sellUsd / item.buyUsd) * 100 : null),
  buyCount: (item) => item.buyCount,
  marketCap: (item) => (item.marketCap > 0 ? item.marketCap : null),
  liquidity: (item) => item.liquidity,
  volume24h: (item) => item.volume24h,
  volumeToMcap: (item) => (item.marketCap > 0 ? item.volume24h / item.marketCap : null),
  priceChange24h: (item) => item.priceChange24h,
  buyerRealizedPnl30d: (item) => item.buyerRealizedPnl30d,
  lastBuyHours: (item, now) => {
    const at = Date.parse(item.lastBuyAt)
    return Number.isFinite(at) ? (now - at) / HOUR_MS : null
  },
  firstSeenHours: (item, now) => {
    const at = item.firstSeenAt ? Date.parse(item.firstSeenAt) : NaN
    return Number.isFinite(at) ? (now - at) / HOUR_MS : null
  },
  peakMultiple: (item) => item.peakMultiple,
}

export interface FilterRule {
  field: string
  op: 'gte' | 'lte'
  value: number
}

const MAX_RULES = 12

/** Reads the `rules` query value. Anything malformed or unknown is dropped rather than rejected. */
export function parseRules(raw: unknown): FilterRule[] {
  if (typeof raw !== 'string' || !raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  return sanitizeRules(parsed)
}

/** Keeps only well-formed rules on known fields, up to the limit. Used for saved filters too. */
export function sanitizeRules(parsed: unknown): FilterRule[] {
  if (!Array.isArray(parsed)) return []
  return parsed
    .filter(
      (rule): rule is FilterRule =>
        Boolean(rule) &&
        typeof rule.field === 'string' &&
        rule.field in FILTER_FIELDS &&
        (rule.op === 'gte' || rule.op === 'lte') &&
        typeof rule.value === 'number' &&
        Number.isFinite(rule.value)
    )
    .slice(0, MAX_RULES)
}

/** True when the token meets every rule. */
export function matchesRules(item: FilterableBuy, rules: FilterRule[], now = Date.now()): boolean {
  return rules.every((rule) => {
    const value = FILTER_FIELDS[rule.field](item, now)
    if (value === null || !Number.isFinite(value)) return false
    return rule.op === 'gte' ? value >= rule.value : value <= rule.value
  })
}
