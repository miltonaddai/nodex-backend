/**
 * Buy-or-avoid assessment for the token scanner. Each check is a lesson from tokens reviewed
 * while building WhaleMo: pulled liquidity behind a live-looking chart, launches bundled by one
 * person, bot farms that inflate holder counts, and contracts that can still mint or freeze.
 *
 * This is risk triage, not a prediction. A clean report means none of the known traps were
 * found, not that the token will go up.
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low'

export interface RiskFlag {
  severity: Severity
  title: string
  detail: string
}

export interface Positive {
  title: string
  detail: string
}

export type Verdict = 'avoid' | 'caution' | 'favorable'

export interface RiskReport {
  verdict: Verdict
  /** 0 (no known risk) to 100. */
  riskScore: number
  flags: RiskFlag[]
  positives: Positive[]
}

export interface ScanFacts {
  liquidityUsd: number | null
  marketCapUsd: number | null
  ageHours: number | null
  /** Solana: the mint can still create supply. EVM: not checked, so null. */
  mintAuthorityActive: boolean | null
  freezeAuthorityActive: boolean | null
  transferFeeBps: number | null
  /** Someone can still change the transfer fee. */
  transferFeeChangeable: boolean | null
  permanentDelegate: boolean | null
  /** EVM: source code published on the explorer. */
  contractVerified: boolean | null
  /** EVM contract audit: buying works but selling does not. Null where not checked. */
  honeypot?: boolean | null
  holders: number | null
  uniqueWallets24h: number | null
  buys24h: number | null
  sells24h: number | null
  /** Share of supply held by the top 10 non-pool wallets. */
  top10Pct: number | null
  largestHolderPct: number | null
  bundle: { insiderAcquiredPct: number; insiderHoldingPct: number | null; linkedWallets: number } | null
  smartMoneyBuyers: number
}

const WEIGHT: Record<Severity, number> = { critical: 60, high: 25, medium: 10, low: 4 }

function pct(value: number): string {
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}%`
}

function usd(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`
  return `$${Math.round(value)}`
}

export function assessRisk(facts: ScanFacts): RiskReport {
  const flags: RiskFlag[] = []
  const positives: Positive[] = []
  const add = (severity: Severity, title: string, detail: string) => flags.push({ severity, title, detail })

  // Liquidity: without it nothing else matters.
  const liquidity = facts.liquidityUsd ?? 0
  if (liquidity < 5_000) {
    add('critical', 'No real liquidity', `Only ${usd(liquidity)} in the pool. It has likely been pulled, and you could not sell.`)
  } else if (facts.marketCapUsd && liquidity / facts.marketCapUsd < 0.03) {
    add('medium', 'Thin liquidity', `Liquidity is ${pct((liquidity / facts.marketCapUsd) * 100)} of market cap. Larger sells will move the price hard.`)
  } else {
    positives.push({ title: 'Tradeable liquidity', detail: `${usd(liquidity)} in the pool.` })
  }
  if (facts.marketCapUsd && liquidity >= 5_000 && facts.marketCapUsd / liquidity > 200) {
    add('high', 'Market cap does not match liquidity', `Market cap is ${Math.round(facts.marketCapUsd / liquidity)}x liquidity, which usually means a mispriced or manipulated pool.`)
  }

  // Contract controls.
  if (facts.honeypot) add('critical', 'Honeypot', 'The contract audit found that the token cannot be sold once bought.')
  if (facts.mintAuthorityActive) add('critical', 'Mint authority active', 'The creator can mint new tokens and dilute holders at any time.')
  else if (facts.mintAuthorityActive === false) positives.push({ title: 'Mint authority revoked', detail: 'No one can create more supply.' })
  if (facts.freezeAuthorityActive) add('high', 'Freeze authority active', 'The creator can freeze your tokens so they cannot be sold.')
  else if (facts.freezeAuthorityActive === false) positives.push({ title: 'Freeze authority revoked', detail: 'Tokens cannot be frozen.' })
  if (facts.permanentDelegate) add('critical', 'Permanent delegate', 'A delegate can move or burn tokens from any wallet.')
  if (facts.transferFeeBps && facts.transferFeeBps > 0) {
    const fee = facts.transferFeeBps / 100
    add(fee >= 5 ? 'high' : 'medium', `${fee}% transfer fee`, `Every transfer, including buys and sells, pays a ${fee}% fee.`)
  }
  if (facts.transferFeeChangeable) {
    add('high', 'Transfer fee can be raised', 'A fee authority is still set, so the fee on buys and sells can be increased after you buy.')
  }
  if (facts.contractVerified === false) add('high', 'Unverified contract', 'The source code is not published, so hidden functions cannot be ruled out.')
  else if (facts.contractVerified) positives.push({ title: 'Verified contract', detail: 'Source code is published on the explorer.' })

  // Holders.
  if (facts.largestHolderPct !== null && facts.largestHolderPct >= 10) {
    add('high', 'One wallet holds a large share', `The largest non-pool wallet holds ${pct(facts.largestHolderPct)} of supply.`)
  }
  if (facts.top10Pct !== null) {
    if (facts.top10Pct >= 40) add('high', 'Supply concentrated in few wallets', `The top 10 wallets hold ${pct(facts.top10Pct)}. A few sellers can crash the price.`)
    else if (facts.top10Pct >= 25) add('medium', 'Moderately concentrated supply', `The top 10 wallets hold ${pct(facts.top10Pct)}.`)
    else positives.push({ title: 'Spread-out supply', detail: `The top 10 wallets hold ${pct(facts.top10Pct)}.` })
  }

  // Trading shape. Churn = unique traders in 24h / holders. Bot farms pin it near 1.
  if (facts.holders && facts.uniqueWallets24h !== null && facts.holders >= 100) {
    const churn = facts.uniqueWallets24h / facts.holders
    if (churn >= 0.5 && churn <= 1.2) {
      add('medium', 'Bot-farm trading pattern', `Trader churn is ${churn.toFixed(2)}x, the band where one wallet per holder trades once.`)
    } else if (churn >= 1.5) {
      positives.push({ title: 'Organic trading pattern', detail: `Trader churn is ${churn.toFixed(2)}x, typical of real traders.` })
    }
  }
  if (facts.buys24h && facts.sells24h !== null && facts.sells24h > 0 && facts.buys24h / facts.sells24h > 3) {
    add('medium', 'Buys far outnumber sells', `${facts.buys24h.toLocaleString()} buys to ${facts.sells24h.toLocaleString()} sells in 24h can signal a pumped chart.`)
  }

  // Launch bundle.
  if (facts.bundle) {
    const { insiderAcquiredPct, insiderHoldingPct } = facts.bundle
    if (insiderAcquiredPct >= 10) {
      if (insiderHoldingPct !== null && insiderHoldingPct >= 5) {
        add('high', 'Launch insiders still hold', `Linked wallets bought ${pct(insiderAcquiredPct)} at launch and still hold ${pct(insiderHoldingPct)}. They can dump on buyers.`)
      } else {
        add('low', 'Bundled launch, insiders exited', `Linked wallets bought ${pct(insiderAcquiredPct)} at launch but have since sold.`)
      }
    } else if (insiderAcquiredPct < 3) {
      positives.push({ title: 'Clean launch', detail: `Linked wallets took only ${pct(insiderAcquiredPct)} at launch.` })
    }
  }

  // Age.
  if (facts.ageHours !== null && facts.ageHours < 1) add('medium', 'Under an hour old', 'Very new tokens are where most rugs happen.')

  // Smart money.
  if (facts.smartMoneyBuyers >= 3) {
    positives.push({ title: `${facts.smartMoneyBuyers} top traders buying`, detail: 'Tracked FOMO top traders are net buyers over the last 72 hours.' })
  } else if (facts.smartMoneyBuyers > 0) {
    positives.push({ title: `${facts.smartMoneyBuyers} top trader buying`, detail: 'A tracked FOMO top trader is a net buyer over the last 72 hours.' })
  }

  const order: Severity[] = ['critical', 'high', 'medium', 'low']
  flags.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity))
  const riskScore = Math.min(100, flags.reduce((sum, flag) => sum + WEIGHT[flag.severity], 0))
  // Avoid on any critical flag, or when high and medium flags pile up past two highs plus a medium.
  const verdict: Verdict =
    flags.some((f) => f.severity === 'critical') || riskScore >= 60 ? 'avoid' : riskScore >= 20 ? 'caution' : 'favorable'
  return { verdict, riskScore, flags, positives }
}
