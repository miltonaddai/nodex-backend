/// <reference types="node" />
import { countClickhouseRows, queryClickhouse } from '../src/services/clickhouse'

async function main() {
  console.log('ROUTE_COUNT', await countClickhouseRows('token_analytics', 'solana', 7, 'recent-tokens'))

  // How many currently-known launches would survive the proposed discovery filters?
  const impact = await queryClickhouse<Record<string, unknown>>(
    `SELECT
       count() AS launches,
       countIf(h.volume_24h >= 500000) AS vol_500k,
       countIf(h.liquidity >= 50000) AS liq_50k,
       countIf(l.holders >= 100) AS holders_100,
       countIf(h.volume_24h >= 500000 AND h.liquidity >= 50000 AND l.holders >= 100) AS all_three,
       countIf(h.volume_24h >= 500000 AND h.liquidity >= 50000 AND l.holders >= 100
               AND l.launched_at <= now() - INTERVAL 3 DAY) AS all_three_mature
     FROM token_launches AS l FINAL
     LEFT JOIN token_market_health AS h FINAL ON h.contract = l.contract AND h.chain = l.chain
     WHERE l.chain='solana' AND l.launched_at >= now() - INTERVAL 30 DAY`
  )
  console.log('FILTER_IMPACT', JSON.stringify(impact))

  // Current distribution, to see where the proposed bars sit.
  const dist = await queryClickhouse<Record<string, unknown>>(
    `SELECT
       round(quantile(0.5)(h.volume_24h),0) AS vol_p50,
       round(quantile(0.9)(h.volume_24h),0) AS vol_p90,
       round(max(h.volume_24h),0) AS vol_max,
       round(quantile(0.9)(h.liquidity),0) AS liq_p90,
       round(max(h.liquidity),0) AS liq_max,
       round(quantile(0.9)(l.holders),0) AS holders_p90,
       max(l.holders) AS holders_max
     FROM token_launches AS l FINAL
     LEFT JOIN token_market_health AS h FINAL ON h.contract = l.contract AND h.chain = l.chain
     WHERE l.chain='solana' AND l.launched_at >= now() - INTERVAL 30 DAY`
  )
  console.log('DISTRIBUTION', JSON.stringify(dist))
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
