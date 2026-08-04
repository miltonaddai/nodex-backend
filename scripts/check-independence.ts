/// <reference types="node" />
import { queryClickhouse } from '../src/services/clickhouse'

/**
 * Is "0 independent buyers" a real bundle signal, or just an artifact of only ~51 contracts
 * being ingested? Compares each token's buyer independence against the ingested universe.
 */
async function main() {
  const rows = await queryClickhouse<Record<string, unknown>>(
    `SELECT
       t.symbol AS symbol,
       t.real_buyers AS real_buyers,
       t.independent_buyers AS independent_buyers,
       round(t.independent_buyers / nullIf(t.real_buyers, 0), 3) AS indep_share,
       t.safety_failed AS safety_failed
     FROM token_analytics AS t FINAL
     WHERE t.chain='solana' AND t.period_days=7 AND t.evidence_tier='verified'
       AND t.real_buyers >= 50
     ORDER BY t.real_buyers DESC LIMIT 20`
  )
  console.log('INDEPENDENCE', JSON.stringify(rows, null, 1))

  // Baseline: across all ingested trades, how many wallets touch more than one contract at all?
  const baseline = await queryClickhouse<Record<string, unknown>>(
    `SELECT
       count() AS wallets,
       countIf(tokens > 1) AS multi_token_wallets,
       round(countIf(tokens > 1) / count(), 3) AS multi_share,
       max(tokens) AS max_tokens
     FROM (
       SELECT wallet_address, uniqExact(contract) AS tokens
       FROM wallet_token_trades WHERE chain='solana' GROUP BY wallet_address
     )`
  )
  console.log('BASELINE', JSON.stringify(baseline))
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
