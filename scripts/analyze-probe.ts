/// <reference types="node" />
import { readFileSync } from 'fs'

/** Re-analyses the probe output locally so no further API calls are spent. */
interface Row {
  symbol: string
  age: string
  holders: number
  fdv: number
  mcap: number
  liq: number
  vol24h: number
  trades24h: number
  wallets24h: number
  mcap_per_wallet: number | null
  buy_sell_ratio: number | null
}

function main() {
  const log = readFileSync(process.argv[2] ?? '/tmp/probe.log', 'utf8')
  const start = log.indexOf('TOKENS ')
  const rows: Row[] = JSON.parse(log.slice(start + 'TOKENS '.length))

  const zeroLiq = rows.filter((r) => r.liq < 1000).length
  const liq50k = rows.filter((r) => r.liq >= 50_000)
  // Nearly every holder trading within 24h is the signature of a bot-seeded holder base.
  const churnRatio = (r: Row) => (r.holders > 0 ? r.wallets24h / r.holders : 0)
  const highChurn = rows.filter((r) => churnRatio(r) > 0.5).length
  // Buy and sell volume within a couple of percent is what wash trading looks like.
  const balanced = rows.filter(
    (r) => r.buy_sell_ratio !== null && Math.abs(r.buy_sell_ratio - 1) < 0.05
  ).length

  console.log(
    'QUALITY',
    JSON.stringify({
      total: rows.length,
      near_zero_liquidity: zeroLiq,
      liquidity_ge_50k: liq50k.length,
      wallets24h_over_half_of_holders: highChurn,
      buy_sell_within_5pct: balanced,
    })
  )

  const survivors = rows.filter(
    (r) =>
      r.liq >= 50_000 &&
      churnRatio(r) <= 0.5 &&
      r.buy_sell_ratio !== null &&
      Math.abs(r.buy_sell_ratio - 1) >= 0.05
  )
  console.log('SURVIVORS_COUNT', survivors.length)
  console.log(
    'SURVIVORS',
    JSON.stringify(
      survivors
        .map((r) => ({
          ...r,
          churn: Math.round(churnRatio(r) * 100) / 100,
        }))
        .sort((a, b) => a.churn - b.churn)
        .slice(0, 20),
      null,
      1
    )
  )
}

main()
