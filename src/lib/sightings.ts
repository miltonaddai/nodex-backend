/**
 * Folds market readings into a token's first sighting and peak since.
 *
 * The multiple is measured on price, not market cap. For a fixed-supply token the two move
 * together, but Dexscreener's market cap for bridged tokens flips between supply figures from one
 * reading to the next (one token alternated between $0.03M and $140M at a steady price), so
 * market cap is kept for display only.
 *
 * Readings come from the pipeline's own market data, once per run. A bad quote, such as a
 * spoofed pool or a one-off glitch, would otherwise set a peak that never comes down. A real
 * pump grows a pool's liquidity much more slowly than its price (a constant-product pool's
 * liquidity grows with the square root of price unless someone deposits), so a reading that
 * jumps far in both price and liquidity since the last accepted one is ignored.
 */

/** A reading this many times the last accepted price and liquidity is ignored. */
export const MAX_JUMP = 30

export interface Reading {
  /** Unix seconds. */
  at: number
  price: number
  marketCap: number
  liquidity: number
}

export interface Sighting {
  firstSeenAt: number
  /** Price and market cap at the first priced reading. 0 until one exists. */
  firstPrice: number
  firstMc: number
  peakPrice: number
  /** Market cap at the peak-price reading, for display. */
  peakMc: number
  peakAt: number
  /** Last accepted reading, which the next one is compared against. */
  lastPrice: number
  lastLiq: number
}

export function isImplausibleJump(previous: Sighting, reading: Reading): boolean {
  if (previous.lastPrice <= 0) return false
  return (
    reading.price > previous.lastPrice * MAX_JUMP &&
    reading.liquidity > Math.max(previous.lastLiq, 1) * MAX_JUMP
  )
}

/**
 * Applies one reading. A reading without a price can only move first-seen earlier, which is how
 * an insider play's original analysis time is used.
 */
export function advanceSighting(previous: Sighting | undefined, reading: Reading): Sighting {
  const firstSeenAt = previous ? Math.min(previous.firstSeenAt, reading.at) : reading.at
  if (reading.price <= 0) {
    return previous
      ? { ...previous, firstSeenAt }
      : { firstSeenAt, firstPrice: 0, firstMc: 0, peakPrice: 0, peakMc: 0, peakAt: 0, lastPrice: 0, lastLiq: 0 }
  }
  if (!previous || previous.firstPrice <= 0) {
    return {
      firstSeenAt,
      firstPrice: reading.price,
      firstMc: reading.marketCap,
      peakPrice: reading.price,
      peakMc: reading.marketCap,
      peakAt: reading.at,
      lastPrice: reading.price,
      lastLiq: reading.liquidity,
    }
  }
  if (isImplausibleJump(previous, reading)) return { ...previous, firstSeenAt }
  const newPeak = reading.price > previous.peakPrice
  return {
    ...previous,
    firstSeenAt,
    peakPrice: newPeak ? reading.price : previous.peakPrice,
    peakMc: newPeak ? reading.marketCap : previous.peakMc,
    peakAt: newPeak ? reading.at : previous.peakAt,
    lastPrice: reading.price,
    lastLiq: reading.liquidity,
  }
}

/** Peak price over first price, at least 1. Null until a priced reading exists. */
export function peakMultiple(firstPrice: number, peakPrice: number): number | null {
  return firstPrice > 0 && peakPrice > 0 ? Math.max(1, peakPrice / firstPrice) : null
}
