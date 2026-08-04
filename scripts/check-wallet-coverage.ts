/// <reference types="node" />
import { queryClickhouse } from '../src/services/clickhouse'

/** How much wallet-level data exists for the churn-qualified token set. */
async function main() {
  const q = async (label: string, sql: string) => {
    console.log(label, JSON.stringify(await queryClickhouse<Record<string, unknown>>(sql)))
  }

  await q(
    'QUALIFIED',
    `SELECT uniqExact(contract) AS tokens,
       uniqExactIf(contract, contract IN (SELECT DISTINCT contract FROM wallet_token_trades WHERE chain='solana')) AS with_raw_trades,
       uniqExactIf(contract, contract IN (SELECT DISTINCT contract FROM wallet_token_performance FINAL WHERE chain='solana')) AS with_performance
     FROM token_analytics FINAL
     WHERE chain='solana' AND period_days=7 AND churn_qualified=1`
  )

  // Wallets trading more than one qualified token — the population the wallets page should rank.
  await q(
    'MULTI_TOKEN_WALLETS',
    `SELECT
       count() AS wallets,
       countIf(qualified_tokens >= 2) AS on_2_plus,
       countIf(qualified_tokens >= 3) AS on_3_plus,
       max(qualified_tokens) AS max_tokens
     FROM (
       SELECT wallet_address, uniqExact(contract) AS qualified_tokens
       FROM wallet_token_performance FINAL
       WHERE chain='solana' AND period_days=7
         AND contract IN (
           SELECT contract FROM token_analytics FINAL
           WHERE chain='solana' AND period_days=7 AND churn_qualified=1
         )
       GROUP BY wallet_address
     )`
  )

  // Same, from raw trades, which cover more tokens than the aggregated performance table.
  await q(
    'MULTI_FROM_RAW',
    `SELECT count() AS wallets, countIf(t >= 2) AS on_2_plus, countIf(t >= 3) AS on_3_plus
     FROM (
       SELECT wallet_address, uniqExact(contract) AS t
       FROM wallet_token_trades
       WHERE chain='solana'
         AND contract IN (
           SELECT contract FROM token_analytics FINAL
           WHERE chain='solana' AND period_days=7 AND churn_qualified=1
         )
       GROUP BY wallet_address
     )`
  )
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
