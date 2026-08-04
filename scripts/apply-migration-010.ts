/// <reference types="node" />
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { getClickhouse } from '../src/services/clickhouse'

async function main() {
  const client = getClickhouse()
  if (!client) throw new Error('ClickHouse is not configured')
  const sql = readFileSync(resolve(__dirname, '../sql/clickhouse/migrations/010-churn-discovery.sql'), 'utf8')
  const statements = sql
    .split(';')
    .map((statement) =>
      statement
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim()
    )
    .filter(Boolean)

  for (const statement of statements) {
    console.log(`Executing:\n${statement.slice(0, 120)}...`)
    await client.command({ query: statement })
  }
  console.log('Migration 010 applied')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
