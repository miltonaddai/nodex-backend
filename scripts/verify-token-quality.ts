/// <reference types="node" />
import { refreshTokenMarketHealth } from '../src/workers/sync-market-health'
import { refreshTokenScores } from '../src/workers/sync-alpha'
import { queryClickhouse } from '../src/services/clickhouse'
import { getSolanaTokenMarketHealth } from '../src/services/dexscreener'

const RUGGED = 'EsL3AQw11KoBtEpbUZXkgWh4xwiyod6A5U3KYmwEPUMP'

async function main() {
  const live = await getSolanaTokenMarketHealth([RUGGED])
  console.log('Live Dexscreener health for rugged token:', live.get(RUGGED) ?? null)

  await refreshTokenMarketHealth('solana')
  await refreshTokenScores('solana')

  const health = await queryClickhouse<{
    contract: string
    market_cap: number
    liquidity: number
    healthy: number
    risk_flags: string[]
  }>(
    `SELECT contract, market_cap, liquidity, healthy, risk_flags
     FROM token_market_health FINAL
     WHERE chain = 'solana' AND contract = {contract:String}
     LIMIT 1`,
    { contract: RUGGED }
  )
  console.log('Stored market health:', health[0] ?? null)

  const scores = await queryClickhouse<{
    period_days: number
    alpha_score: number
    market_cap: number
    qualified_wallet_buyers: number
    risk_flags: string[]
  }>(
    `SELECT period_days, alpha_score, market_cap, qualified_wallet_buyers, risk_flags
     FROM token_analytics FINAL
     WHERE chain = 'solana' AND contract = {contract:String}
     ORDER BY period_days`,
    { contract: RUGGED }
  )
  console.log('Stored alpha scores:', scores)

  const ranked = await queryClickhouse<{ contract: string; alpha_score: number }>(
    `SELECT t.contract AS contract, t.alpha_score AS alpha_score
     FROM token_analytics AS t FINAL
     INNER JOIN (
       SELECT contract, chain
       FROM token_market_health FINAL
       WHERE chain = 'solana'
         AND healthy = 1
         AND checked_at >= now() - toIntervalMinute(30)
     ) AS h ON h.chain = t.chain AND h.contract = t.contract
     WHERE t.chain = 'solana'
       AND t.period_days = 7
       AND t.alpha_score > 0
       AND t.qualified_wallet_buyers >= 2
       AND t.contract = {contract:String}`,
    { contract: RUGGED }
  )
  console.log('Appears in healthy ranking filter:', ranked.length > 0 ? ranked : [])
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
