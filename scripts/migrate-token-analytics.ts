import 'dotenv/config'
import { readFileSync } from 'fs'
import { join } from 'path'
import { getClickhouse } from '../src/services/clickhouse'

async function main() {
  const client = getClickhouse()
  if (!client) throw new Error('ClickHouse is not configured')

  const sql = readFileSync(
    join(__dirname, '../sql/clickhouse/migrations/003-token-analytics-order-by.sql'),
    'utf8'
  )

  const statements = sql
    .split(';')
    .map((s) =>
      s
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim()
    )
    .filter((s) => s.length > 0)

  for (const statement of statements) {
    console.log(`Running: ${statement.slice(0, 80)}...`)
    await client.command({ query: statement })
  }

  const verify = await client.query({
    query: `SELECT period_days, count() AS c
            FROM token_analytics FINAL
            WHERE chain = 'solana'
            GROUP BY period_days
            ORDER BY period_days`,
    format: 'JSONEachRow',
  })
  console.log('Post-migration counts (FINAL):', await verify.json())
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
