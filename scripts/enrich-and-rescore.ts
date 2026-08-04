/// <reference types="node" />
import { config } from '../src/config'
import { syncAllHolderWealth } from '../src/workers/sync-holder-wealth'
import { refreshTokenScores } from '../src/workers/sync-alpha'
import { queryClickhouse } from '../src/services/clickhouse'

/** Enriches top-holder balances via Helius, then rescores. Does not touch the Birdeye quota. */
async function main() {
  await syncAllHolderWealth()
  for (const chain of config.worker.syncChains) {
    await refreshTokenScores(chain)
  }

  const survivors = await queryClickhouse<Record<string, unknown>>(
    `SELECT symbol, round(alpha_score,1) AS alpha, real_buyers, independent_buyers,
            wealthy_holders, enriched_holders, round(median_holder_wealth_usd,0) AS median_wealth,
            round(market_cap,0) AS mcap,
            round(market_cap / nullIf(real_buyers,0),0) AS mcap_per_buyer
     FROM token_analytics FINAL
     WHERE chain='solana' AND period_days=7 AND alpha_score>0
     ORDER BY alpha_score DESC LIMIT 20`
  )
  console.log('SURVIVORS', JSON.stringify(survivors, null, 1))

  const funnel = await queryClickhouse<Record<string, unknown>>(
    `SELECT
       count() AS tokens,
       countIf(evidence_tier='verified') AS verified,
       countIf(evidence_tier='verified' AND safety_failed=0) AS passed_safety,
       countIf(evidence_tier='verified' AND safety_failed=0 AND real_buyers>=100) AS passed_buyers,
       countIf(alpha_score>0) AS scored,
       max(real_buyers) AS max_real_buyers
     FROM token_analytics FINAL WHERE chain='solana' AND period_days=7`
  )
  console.log('FUNNEL', JSON.stringify(funnel))
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
