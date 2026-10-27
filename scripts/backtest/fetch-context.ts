/**
 * Discovery-time context for pattern mining, from ClickHouse only (no API calls):
 *  - token stats, kept only where the stored row was written within 150m of first sighting
 *    (later rows describe the token after the outcome is known)
 *  - buyer composition from wallet_token_trades strictly before first sighting
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { queryClickhouse } from '../../src/services/clickhouse'

const OUT = process.env.BACKTEST_DIR ?? join(__dirname, 'data')

async function main() {
  const stats = await queryClickhouse<any>(`
    SELECT l.contract AS contract, l.market_cap AS mc, l.liquidity AS liq, l.holders AS holders,
      l.volume_24h AS vol, l.unique_wallet_24h AS uw, l.trade_24h_count AS trades, l.buy_24h AS buys,
      l.sell_24h AS sells, l.churn AS churn, l.price_change_24h AS chg24, l.fdv AS fdv
    FROM token_launches AS l FINAL
    INNER JOIN token_sightings AS s FINAL ON s.contract = l.contract AND s.chain = l.chain
    WHERE l.chain = 'solana' AND s.first_seen_at >= '2026-10-01'
      AND dateDiff('minute', s.first_seen_at, l.updated_at) BETWEEN -150 AND 150`)
  const buyers = await queryClickhouse<any>(`
    WITH s AS (SELECT contract, first_seen_at FROM token_sightings FINAL WHERE chain = 'solana' AND first_seen_at >= '2026-10-01')
    SELECT contract,
      count() AS n, countIf(side = 'buy') AS nBuy,
      uniqExactIf(wallet_address, side = 'buy') AS buyers,
      sumIf(quote_usd, side = 'buy') AS buyUsd, sumIf(quote_usd, side = 'sell') AS sellUsd,
      sumIf(quote_usd, side = 'buy' AND minutes_after_launch <= 5) / greatest(1, sumIf(quote_usd, side = 'buy')) AS sniperShare,
      avgIf(quote_usd, side = 'buy') AS avgBuy, quantileIf(0.5)(quote_usd, side = 'buy') AS medBuy,
      countIf(side = 'buy' AND quote_usd >= 500) AS bigBuys,
      avg(wash_suspected) AS washShare, avg(suspicious) AS suspShare,
      sumIf(quote_usd, side = 'buy' AND block_time >= first_seen_at - INTERVAL 1 HOUR) / greatest(1, sumIf(quote_usd, side = 'sell' AND block_time >= first_seen_at - INTERVAL 1 HOUR) + sumIf(quote_usd, side = 'buy' AND block_time >= first_seen_at - INTERVAL 1 HOUR)) AS buyShare1h
    FROM wallet_token_trades AS t INNER JOIN s USING contract
    WHERE t.chain = 'solana' AND t.block_time < s.first_seen_at
    GROUP BY contract HAVING n >= 20`)
  // Concentration: share of pre-discovery buy volume from the 5 largest buyers.
  const top = await queryClickhouse<any>(`
    WITH s AS (SELECT contract, first_seen_at FROM token_sightings FINAL WHERE chain = 'solana' AND first_seen_at >= '2026-10-01')
    SELECT contract, arraySum(arraySlice(arrayReverseSort(groupArray(v)), 1, 5)) / greatest(1, sum(v)) AS top5Share
    FROM (SELECT contract, wallet_address, sum(quote_usd) v FROM wallet_token_trades AS t INNER JOIN s USING contract
          WHERE t.chain = 'solana' AND side = 'buy' AND t.block_time < s.first_seen_at GROUP BY contract, wallet_address)
    GROUP BY contract`)
  const topBy = new Map(top.map((r) => [r.contract, Number(r.top5Share)]))
  writeFileSync(join(OUT, 'context.json'), JSON.stringify({
    stats: Object.fromEntries(stats.map((r) => [r.contract, r])),
    buyers: Object.fromEntries(buyers.map((r) => [r.contract, { ...r, top5Share: topBy.get(r.contract) ?? null }])),
  }))
  console.log(`stats ${stats.length}, buyers ${buyers.length}`)
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
