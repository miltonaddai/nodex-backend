// Read-only: compare what the tokens page cache holds with what ClickHouse has now.
import { queryClickhouse, getPipelineSchedule } from '../../src/services/clickhouse'
import { getRedis } from '../../src/services/redis'
async function main() {
  console.log('schedule:', JSON.stringify(await getPipelineSchedule()))
  console.log('token_analytics max updated_at by period:', JSON.stringify(await queryClickhouse(
    `SELECT period_days, max(updated_at) AS last, count() AS rows FROM token_analytics FINAL WHERE chain='solana' GROUP BY period_days ORDER BY period_days`)))
  console.log('schedule row history:', JSON.stringify(await queryClickhouse(
    `SELECT updated_at, cursor FROM worker_checkpoints WHERE worker = 'pipeline' ORDER BY updated_at DESC LIMIT 6`).catch((e) => e.message)))
  const r = getRedis()!
  for (const key of await r.keys('*tokens:snapshot:solana:*')) {
    const s = JSON.parse((await r.get(key))!)
    console.log(key, '| lastUpdated', s.value?.lastUpdated, '| freshUntil', new Date(s.freshUntil).toISOString(), '| ttl', await r.ttl(key))
  }
  r.disconnect()
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
