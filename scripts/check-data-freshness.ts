/// <reference types="node" />
import { queryClickhouse } from '../src/services/clickhouse'

async function main() {
  const q = async (label: string, sql: string) => {
    console.log(label, JSON.stringify(await queryClickhouse<Record<string, unknown>>(sql)))
  }

  await q(
    'LAUNCH_AGE',
    `SELECT
       count() AS tokens,
       min(launched_at) AS oldest,
       max(launched_at) AS newest,
       countIf(launched_at >= now() - INTERVAL 1 DAY) AS last_24h,
       countIf(launched_at >= now() - INTERVAL 7 DAY) AS last_7d,
       countIf(launched_at >= now() - INTERVAL 30 DAY) AS last_30d,
       round(avg(dateDiff('hour', launched_at, now())),1) AS avg_age_hours
     FROM token_launches FINAL WHERE chain='solana'`
  )

  // Which tokens actually have trade evidence, and how old are they?
  await q(
    'INGESTED_AGE',
    `SELECT
       count() AS ingested_tokens,
       min(l.launched_at) AS oldest,
       max(l.launched_at) AS newest,
       round(avg(dateDiff('hour', l.launched_at, now())),1) AS avg_age_hours,
       countIf(dateDiff('hour', l.launched_at, now()) <= 24) AS ingested_under_24h
     FROM token_launches AS l FINAL
     WHERE l.chain='solana'
       AND l.contract IN (SELECT DISTINCT contract FROM wallet_token_trades WHERE chain='solana')`
  )

  await q(
    'TRADE_WINDOW',
    `SELECT min(block_time) AS oldest_trade, max(block_time) AS newest_trade,
            round(dateDiff('hour', min(block_time), max(block_time)),1) AS span_hours,
            count() AS trades
     FROM wallet_token_trades WHERE chain='solana'`
  )

  // How fresh is the snapshot the API serves?
  await q(
    'SNAPSHOT',
    `SELECT max(updated_at) AS analytics_updated,
            round(dateDiff('minute', max(updated_at), now()),1) AS analytics_age_min
     FROM token_analytics FINAL WHERE chain='solana' AND period_days=7`
  )
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
