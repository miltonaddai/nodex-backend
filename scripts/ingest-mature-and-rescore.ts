/// <reference types="node" />
import { config } from '../src/config'
import { refreshTokenScores, syncAllAlphaTrades } from '../src/workers/sync-alpha'
import { syncAllHolderWealth } from '../src/workers/sync-holder-wealth'
import { queryClickhouse } from '../src/services/clickhouse'

/**
 * Full alpha rebuild over the maturity window: ingest raw trades, enrich top-holder balances,
 * then rescore. Helius-bound; the only Birdeye call is one SOL price lookup.
 */
async function main() {
  await syncAllAlphaTrades()
  await syncAllHolderWealth()
  for (const chain of config.worker.syncChains) {
    await refreshTokenScores(chain)
  }

  const coverage = await queryClickhouse<Record<string, unknown>>(
    `SELECT uniqExact(contract) AS ingested_contracts, count() AS trades,
            min(block_time) AS oldest, max(block_time) AS newest
     FROM wallet_token_trades WHERE chain='solana'`
  )
  console.log('COVERAGE', JSON.stringify(coverage))

  const funnel = await queryClickhouse<Record<string, unknown>>(
    `SELECT count() AS tokens,
       countIf(evidence_tier='verified') AS verified,
       countIf(evidence_tier='verified' AND safety_failed=0) AS passed_safety,
       countIf(evidence_tier='verified' AND safety_failed=0 AND real_buyers>=100) AS passed_buyers,
       countIf(alpha_score>0) AS scored,
       max(real_buyers) AS max_buyers
     FROM token_analytics FINAL WHERE chain='solana' AND period_days=7`
  )
  console.log('FUNNEL', JSON.stringify(funnel))

  const survivors = await queryClickhouse<Record<string, unknown>>(
    `SELECT symbol, round(alpha_score,1) AS alpha, real_buyers, independent_buyers,
            wealthy_holders, enriched_holders, round(median_holder_wealth_usd,0) AS median_wealth,
            round(retention_rate,2) AS retention, age_days,
            round(market_cap,0) AS mcap
     FROM token_analytics FINAL
     WHERE chain='solana' AND period_days=7 AND alpha_score>0
     ORDER BY alpha_score DESC LIMIT 15`
  )
  console.log('SURVIVORS', JSON.stringify(survivors, null, 1))
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
