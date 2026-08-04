/// <reference types="node" />
import { queryClickhouse } from '../src/services/clickhouse'

/**
 * Market cap per real buyer: how much valuation each observed buyer is "supporting".
 * A token with a real holder base spreads its cap across many buyers; a bundle concentrates
 * an enormous cap behind a handful of wallets.
 */
async function main() {
  const rows = await queryClickhouse<Record<string, unknown>>(
    `SELECT t.symbol AS sym, t.age_days AS age_d, t.real_buyers AS buyers,
            t.independent_buyers AS indep, l.holders AS onchain_holders,
            round(h.market_cap, 0) AS mcap,
            round(h.market_cap / nullIf(t.real_buyers, 0), 0) AS mcap_per_buyer,
            round(h.market_cap / nullIf(l.holders, 0), 0) AS mcap_per_holder,
            round(t.real_buyers / nullIf(l.holders, 0), 3) AS sample_coverage
     FROM token_analytics AS t FINAL
     LEFT JOIN token_market_health AS h FINAL ON h.contract=t.contract AND h.chain=t.chain
     LEFT JOIN token_launches AS l FINAL ON l.contract=t.contract AND l.chain=t.chain
     WHERE t.chain='solana' AND t.period_days=7 AND t.evidence_tier='verified'
       AND t.real_buyers >= 20 AND h.market_cap > 0
     ORDER BY mcap_per_buyer ASC LIMIT 20`
  )
  console.log('RATIOS', JSON.stringify(rows, null, 1))

  const dist = await queryClickhouse<Record<string, unknown>>(
    `SELECT count() AS tokens,
       round(quantile(0.25)(ratio),0) AS p25,
       round(quantile(0.5)(ratio),0) AS p50,
       round(quantile(0.75)(ratio),0) AS p75,
       round(min(ratio),0) AS min_ratio,
       countIf(ratio <= 5000) AS le_5k,
       countIf(ratio <= 10000) AS le_10k,
       countIf(ratio <= 25000) AS le_25k
     FROM (
       SELECT h.market_cap / nullIf(t.real_buyers,0) AS ratio
       FROM token_analytics AS t FINAL
       LEFT JOIN token_market_health AS h FINAL ON h.contract=t.contract AND h.chain=t.chain
       WHERE t.chain='solana' AND t.period_days=7 AND t.evidence_tier='verified'
         AND t.real_buyers >= 20 AND h.market_cap > 0
     )`
  )
  console.log('DIST', JSON.stringify(dist))
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
