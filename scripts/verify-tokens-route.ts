/// <reference types="node" />
import {
  countClickhouseRows,
  getSnapshotLastUpdated,
  queryClickhousePaginated,
} from '../src/services/clickhouse'

/** Exercises exactly the query path GET /api/tokens/top uses, without needing an auth token. */
async function main() {
  const chain = 'solana'
  const periodDays = 7

  const total = await countClickhouseRows('token_analytics', chain, periodDays, 'recent-tokens')
  const rows = await queryClickhousePaginated<Record<string, unknown>>({
    table: 'token_analytics',
    chain,
    periodDays,
    sortColumn: 'alpha_score',
    sortOrder: 'desc',
    limit: 10,
    offset: 0,
    filter: 'recent-tokens',
  })
  const lastUpdated = await getSnapshotLastUpdated('token_analytics', chain, periodDays)

  console.log('TOTAL', total)
  console.log('LAST_UPDATED', lastUpdated)
  console.log(
    'ROWS',
    JSON.stringify(
      rows.map((row) => ({
        symbol: row.symbol,
        alpha: Number(row.alpha_score).toFixed(1),
        tier: row.evidence_tier,
        real_buyers: row.real_buyers,
        independent: row.independent_buyers,
        retention: Number(row.retention_rate).toFixed(2),
        flags: row.risk_flags,
      })),
      null,
      1
    )
  )
  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
