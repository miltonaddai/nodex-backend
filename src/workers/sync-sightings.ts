import { advanceSighting, type Reading, type Sighting } from '../lib/sightings'
import { getClickhouse, insertClickhouse, queryClickhouse } from '../services/clickhouse'

/**
 * First-seen time and peak market cap for every token NodeX lists.
 *
 * Runs last in each pipeline run and reads only market caps that run already wrote: the tokens
 * table's market health check, the latest smart money snapshot and the refreshed insider plays.
 * It makes no API calls. Readings are folded by advanceSighting, which measures the multiple on
 * price and ignores implausible jumps from bad quotes.
 *
 * The peak is sampled once per run, so a spike between two runs is missed. The multiple shown
 * is a floor, never an overstatement.
 */

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS token_sightings (
    chain LowCardinality(String),
    contract String,
    first_seen_at DateTime,
    first_price Float64 DEFAULT 0,
    first_mc Float64 DEFAULT 0,
    peak_price Float64 DEFAULT 0,
    peak_mc Float64 DEFAULT 0,
    peak_at DateTime DEFAULT toDateTime(0),
    last_price Float64 DEFAULT 0,
    last_liq Float64 DEFAULT 0,
    updated_at DateTime DEFAULT now()
  ) ENGINE = ReplacingMergeTree(updated_at)
  ORDER BY (chain, contract)`

interface ReadingRow {
  chain: string
  contract: string
  at: string
  price: number
  mc: number
  liq: number
}

interface SightingRow {
  chain: string
  contract: string
  first_seen_at: number
  first_price: number
  first_mc: number
  peak_price: number
  peak_mc: number
  peak_at: number
  last_price: number
  last_liq: number
}

/**
 * Every reading the tables still hold, oldest first: up to 7 days of smart money snapshots, each
 * insider play's original analysis time, and unmerged rows of the other tables. Seeds the table
 * once so existing tokens are not all "first seen" the day this shipped.
 */
const HISTORY = `SELECT chain, contract, at, price, mc, liq FROM (
    SELECT chain, contract, toUnixTimestamp(snapshot_at) AS at, price, market_cap AS mc, liquidity AS liq
    FROM smart_money_buys
    UNION ALL
    SELECT chain, contract, toUnixTimestamp(updated_at), price, market_cap, liquidity FROM token_insider_analysis
    UNION ALL
    SELECT chain, contract, toUnixTimestamp(analyzed_at), 0, 0, 0 FROM token_insider_analysis
    UNION ALL
    SELECT chain, contract, toUnixTimestamp(checked_at), price, market_cap, liquidity
    FROM token_market_health WHERE healthy = 1
  )
  ORDER BY chain, contract, at`

/**
 * This run's reading per token, from the most recent table that priced it. Inner names differ
 * from the outer aliases because ClickHouse resolves a WHERE name to a same-named SELECT alias.
 */
const CURRENT = `SELECT chain, contract, max(seen) AS at, argMax(p, seen) AS price, argMax(cap, seen) AS mc,
    argMax(pool, seen) AS liq
  FROM (
    SELECT chain, contract, toUnixTimestamp(checked_at) AS seen, price AS p, market_cap AS cap, liquidity AS pool
    FROM token_market_health FINAL WHERE healthy = 1 AND checked_at >= {since:DateTime}
    UNION ALL
    SELECT chain, contract, toUnixTimestamp(snapshot_at), price, market_cap, liquidity
    FROM smart_money_buys WHERE snapshot_at >= {since:DateTime}
    UNION ALL
    SELECT chain, contract, toUnixTimestamp(updated_at), price, market_cap, liquidity
    FROM token_insider_analysis FINAL WHERE updated_at >= {since:DateTime}
  )
  WHERE p > 0
  GROUP BY chain, contract`

function clickhouseTime(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 19).replace('T', ' ')
}

function toReading(row: ReadingRow): Reading {
  return { at: Number(row.at), price: Number(row.price), marketCap: Number(row.mc), liquidity: Number(row.liq) }
}

function toRow(chain: string, contract: string, s: Sighting, now: number): Record<string, unknown> {
  return {
    chain,
    contract,
    first_seen_at: clickhouseTime(s.firstSeenAt),
    first_price: s.firstPrice,
    first_mc: s.firstMc,
    peak_price: s.peakPrice,
    peak_mc: s.peakMc,
    peak_at: clickhouseTime(s.peakAt),
    last_price: s.lastPrice,
    last_liq: s.lastLiq,
    updated_at: clickhouseTime(now),
  }
}

async function backfill(now: number): Promise<number> {
  const folded = new Map<string, { chain: string; contract: string; sighting: Sighting }>()
  for (const row of await queryClickhouse<ReadingRow>(HISTORY)) {
    const key = `${row.chain}:${row.contract}`
    const entry = folded.get(key)
    folded.set(key, {
      chain: row.chain,
      contract: row.contract,
      sighting: advanceSighting(entry?.sighting, toReading(row)),
    })
  }
  await insertClickhouse(
    'token_sightings',
    [...folded.values()].map((e) => toRow(e.chain, e.contract, e.sighting, now))
  )
  return folded.size
}

/** Records sightings for everything this run priced. `runStartedAt` bounds "this run". */
export async function syncTokenSightings(runStartedAt: Date): Promise<void> {
  const client = getClickhouse()
  if (!client) return
  const now = Math.floor(Date.now() / 1000)

  await client.command({ query: CREATE_TABLE })
  const [{ total }] = await queryClickhouse<{ total: string }>('SELECT count() AS total FROM token_sightings')
  if (Number(total) === 0) {
    console.log(`[sightings] Backfilled ${await backfill(now)} tokens from existing history`)
  }

  // A minute of slack covers clock differences between the worker and ClickHouse.
  const since = clickhouseTime(Math.floor(runStartedAt.getTime() / 1000) - 60)
  const readings = await queryClickhouse<ReadingRow>(CURRENT, { since })
  if (readings.length === 0) return

  const existing = new Map(
    (
      await queryClickhouse<SightingRow>(
        `SELECT chain, contract, toUnixTimestamp(first_seen_at) AS first_seen_at, first_price, first_mc,
                peak_price, peak_mc, toUnixTimestamp(peak_at) AS peak_at, last_price, last_liq
         FROM token_sightings FINAL`
      )
    ).map((row) => [
      `${row.chain}:${row.contract}`,
      {
        firstSeenAt: Number(row.first_seen_at),
        firstPrice: Number(row.first_price),
        firstMc: Number(row.first_mc),
        peakPrice: Number(row.peak_price),
        peakMc: Number(row.peak_mc),
        peakAt: Number(row.peak_at),
        lastPrice: Number(row.last_price),
        lastLiq: Number(row.last_liq),
      } satisfies Sighting,
    ])
  )

  await insertClickhouse(
    'token_sightings',
    readings.map((row) =>
      toRow(row.chain, row.contract, advanceSighting(existing.get(`${row.chain}:${row.contract}`), toReading(row)), now)
    )
  )
  console.log(`[sightings] ${readings.length} tokens priced this run, ${existing.size} tracked before`)
}
