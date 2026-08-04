/// <reference types="node" />
import { countClickhouseRows } from '../src/services/clickhouse'
import { queryClickhouse } from '../src/services/clickhouse'

async function main() {
  console.log('ROUTE_COUNT', await countClickhouseRows('token_analytics', 'solana', 7, 'recent-tokens'))

  // What do the mature, verified tokens actually look like on the buyer gate?
  const mature = await queryClickhouse<Record<string, unknown>>(
    `SELECT symbol, age_days, real_buyers, independent_buyers, safety_failed,
            round(market_cap,0) AS mcap, arrayStringConcat(risk_flags, ',') AS flags
     FROM token_analytics FINAL
     WHERE chain='solana' AND period_days=7
       AND launched_at <= now() - INTERVAL 3 DAY
       AND evidence_tier='verified'
     ORDER BY real_buyers DESC LIMIT 12`
  )
  console.log('MATURE_VERIFIED', JSON.stringify(mature, null, 1))

  const dist = await queryClickhouse<Record<string, unknown>>(
    `SELECT count() AS mature_verified,
       countIf(safety_failed=0) AS safe,
       countIf(real_buyers >= 100) AS ge100,
       countIf(real_buyers >= 50) AS ge50,
       countIf(real_buyers >= 20) AS ge20,
       max(real_buyers) AS max_buyers,
       round(avg(real_buyers),1) AS avg_buyers
     FROM token_analytics FINAL
     WHERE chain='solana' AND period_days=7
       AND launched_at <= now() - INTERVAL 3 DAY
       AND evidence_tier='verified'`
  )
  console.log('MATURE_DIST', JSON.stringify(dist))
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
