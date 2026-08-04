/// <reference types="node" />
import { refreshAllWalletTokenPerformance, syncAllAlphaTrades } from '../src/workers/sync-alpha'
import { syncAllWallets } from '../src/workers/sync-wallets'
import { queryClickhouse } from '../src/services/clickhouse'

/**
 * Ingests trades for the churn-qualified token list, then rebuilds wallet analytics from it.
 * Helius-bound apart from a single SOL price lookup.
 */
async function main() {
  await syncAllAlphaTrades()
  await refreshAllWalletTokenPerformance()
  await syncAllWallets()

  const coverage = await queryClickhouse<Record<string, unknown>>(
    `SELECT
       uniqExact(q.contract) AS qualified_tokens,
       uniqExactIf(q.contract, q.contract IN (SELECT DISTINCT contract FROM wallet_token_trades WHERE chain='solana')) AS with_trades,
       uniqExactIf(q.contract, q.contract IN (SELECT DISTINCT contract FROM wallet_token_performance FINAL WHERE chain='solana')) AS with_performance
     FROM (
       SELECT DISTINCT contract FROM token_analytics FINAL
       WHERE chain='solana' AND churn_qualified=1
     ) AS q`
  )
  console.log('COVERAGE', JSON.stringify(coverage))

  const wallets = await queryClickhouse<Record<string, unknown>>(
    `SELECT address, qualified_tokens, qualified_wins,
            round(qualified_profit_usd, 0) AS profit_usd,
            round(qualified_win_rate, 0) AS win_rate,
            round(balance, 0) AS balance
     FROM wallet_analytics FINAL
     WHERE chain='solana' AND period_days=7 AND qualified_tokens >= 2 AND qualified_profit_usd > 0
     ORDER BY qualified_tokens DESC, qualified_profit_usd DESC LIMIT 20`
  )
  console.log('WALLETS_COUNT', wallets.length)
  for (const w of wallets) console.log('W', JSON.stringify(w))
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
