/// <reference types="node" />
import { config } from '../src/config'
import { refreshTokenScores } from '../src/workers/sync-alpha'
import { queryClickhouse } from '../src/services/clickhouse'

/**
 * Re-runs alpha scoring only. Reads ClickHouse exclusively — no Birdeye or Helius calls — so it
 * is free to run repeatedly while tuning thresholds.
 */
async function main() {
  for (const chain of config.worker.syncChains) {
    await refreshTokenScores(chain)
  }

  const tiers = await queryClickhouse<Record<string, unknown>>(
    `SELECT evidence_tier, count() AS tokens, countIf(safety_failed = 1) AS safety_failed,
            countIf(alpha_score > 0) AS scored, round(max(alpha_score), 1) AS max_alpha
     FROM token_analytics FINAL
     WHERE chain = 'solana' AND period_days = 7
     GROUP BY evidence_tier ORDER BY tokens DESC`
  )
  console.log('TIERS', JSON.stringify(tiers))

  const top = await queryClickhouse<Record<string, unknown>>(
    `SELECT symbol, round(alpha_score, 1) AS alpha, real_buyers, independent_buyers,
            round(net_inflow_usd, 0) AS inflow, round(retention_rate, 2) AS retention,
            round(top_buyer_share, 2) AS top_share, round(sniper_share, 2) AS sniper
     FROM token_analytics FINAL
     WHERE chain = 'solana' AND period_days = 7 AND alpha_score > 0
     ORDER BY alpha_score DESC LIMIT 10`
  )
  console.log('TOP', JSON.stringify(top, null, 1))

  const flags = await queryClickhouse<Record<string, unknown>>(
    `SELECT flag, count() AS c FROM token_analytics FINAL
     ARRAY JOIN risk_flags AS flag
     WHERE chain = 'solana' AND period_days = 7
     GROUP BY flag ORDER BY c DESC LIMIT 15`
  )
  console.log('FLAGS', JSON.stringify(flags))
  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
