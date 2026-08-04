import { createClient, ClickHouseClient } from '@clickhouse/client'
import { config } from '../config'

let clickhouse: ClickHouseClient | null = null

export function getClickhouse(): ClickHouseClient | null {
  if (!config.clickhouse.url) return null
  if (!clickhouse) {
    clickhouse = createClient({
      url: config.clickhouse.url,
      database: config.clickhouse.database,
      username: config.clickhouse.username,
      password: config.clickhouse.password,
      request_timeout: config.clickhouse.requestTimeoutMs,
    })
  }
  return clickhouse
}

export function isClickhouseConfigured(): boolean {
  return Boolean(config.clickhouse.url)
}

export async function queryClickhouse<T>(query: string, params?: Record<string, unknown>): Promise<T[]> {
  const client = getClickhouse()
  if (!client) return []
  return withClickhouseRetry(async () => {
    const result = await client.query({ query, query_params: params, format: 'JSONEachRow' })
    return result.json<T>()
  })
}

export async function insertClickhouse<T extends Record<string, unknown>>(table: string, rows: T[]): Promise<void> {
  if (rows.length === 0) return
  const client = getClickhouse()
  if (!client) throw new Error('ClickHouse is not configured')
  await withClickhouseRetry(async () => {
    await client.insert({
      table,
      values: rows,
      format: 'JSONEachRow',
    })
  })
}

async function withClickhouseRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await operation()
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
      const transient = [
        'timeout',
        'bad record mac',
        'econnreset',
        'socket hang up',
        'fetch failed',
        'network',
      ].some((fragment) => message.includes(fragment))
      if (!transient || attempt === 2) throw error
      const waitMs = 2_000 * 2 ** attempt
      console.warn(`[clickhouse] Transient connection failure; retrying in ${waitMs}ms`)
      await new Promise((resolve) => setTimeout(resolve, waitMs))
    }
  }
  throw new Error('ClickHouse request failed after retries')
}

export async function getSnapshotLastUpdated(
  table: 'wallet_analytics' | 'token_analytics',
  chain: string,
  periodDays: number
): Promise<string | null> {
  const rows = await queryClickhouse<{ last_updated: string }>(
    `SELECT formatDateTime(max(updated_at), '%Y-%m-%dT%H:%i:%sZ') AS last_updated
     FROM ${table} FINAL
     WHERE chain = {chain:String} AND period_days = {periodDays:UInt16}`,
    { chain, periodDays }
  )
  return rows[0]?.last_updated ?? null
}

export interface ClickhouseListQuery {
  table: 'wallet_analytics' | 'token_analytics'
  chain: string
  periodDays: number
  sortColumn: string
  sortOrder: 'asc' | 'desc'
  limit: number
  offset: number
  filter?: 'smart-wallets' | 'recent-tokens'
  numericFilters?: Record<string, number>
}

const WALLET_FILTER_COLUMNS: Record<string, string> = {
  minBalance: 'balance >=',
  maxBalance: 'balance <=',
  minTotalProfit: 'total_profit >=',
  maxTotalProfit: 'total_profit <=',
  minWinRate: 'win_rate >=',
  maxWinRate: 'win_rate <=',
  minTrades: 'trades >=',
  maxTrades: 'trades <=',
  minTokensHeld: 'tokens_held >=',
  maxTokensHeld: 'tokens_held <=',
  minVolume: 'volume >=',
  maxVolume: 'volume <=',
  minQualifiedTokens: 'qualified_tokens >=',
  maxQualifiedTokens: 'qualified_tokens <=',
  minQualifiedWins: 'qualified_wins >=',
  maxQualifiedWins: 'qualified_wins <=',
  minQualifiedProfit: 'qualified_profit_usd >=',
  maxQualifiedProfit: 'qualified_profit_usd <=',
}

const TOKEN_FILTER_COLUMNS: Record<string, string> = {
  minChurn: 't.churn >=',
  maxChurn: 't.churn <=',
  minPrice: 'h.price >=',
  maxPrice: 'h.price <=',
  minMarketCap: 'h.market_cap >=',
  maxMarketCap: 'h.market_cap <=',
  minChangePct: 'h.price_change_24h >=',
  maxChangePct: 'h.price_change_24h <=',
  minVolume: 'h.volume_24h >=',
  maxVolume: 'h.volume_24h <=',
  minLiquidity: 'h.liquidity >=',
  maxLiquidity: 'h.liquidity <=',
  minAgeDays: 't.age_days >=',
  maxAgeDays: 't.age_days <=',
  minHolders: 't.holders >=',
  maxHolders: 't.holders <=',
}

function numericFilterQuery(
  table: ClickhouseListQuery['table'],
  filters: Record<string, number> = {}
): { sql: string; params: Record<string, number> } {
  const columns = table === 'wallet_analytics' ? WALLET_FILTER_COLUMNS : TOKEN_FILTER_COLUMNS
  const clauses: string[] = []
  const params: Record<string, number> = {}

  for (const [key, value] of Object.entries(filters)) {
    if (table === 'wallet_analytics' && key === 'activeWithinDays' && Number.isFinite(value)) {
      const param = `filter_${key}`
      clauses.push(
        ` AND parseDateTimeBestEffortOrNull(last_active) >= now() - toIntervalDay(toUInt16({${param}:Float64}))`
      )
      params[param] = value
      continue
    }
    const expression = columns[key]
    if (!expression || !Number.isFinite(value)) continue
    const param = `filter_${key}`
    clauses.push(` AND ${expression} {${param}:Float64}`)
    params[param] = value
  }

  return { sql: clauses.join(''), params }
}

function analyticsFilter(filter?: ClickhouseListQuery['filter']): string {
  // Wallets are listed for trading multiple churn-qualified tokens profitably, not for a
  // smart_score derived from whatever tokens ingestion happened to cover.
  if (filter === 'smart-wallets') {
    return ' AND qualified_tokens >= {minQualifiedTokens:UInt16} AND qualified_profit_usd > 0'
  }
  if (filter === 'recent-tokens') {
    return ` AND launched_at >= now() - toIntervalDay({maxAgeDays:UInt16})`
  }
  return ''
}

export async function countClickhouseRows(
  table: 'wallet_analytics' | 'token_analytics',
  chain: string,
  periodDays: number,
  filter?: ClickhouseListQuery['filter'],
  numericFilters?: Record<string, number>
): Promise<number> {
  const numeric = numericFilterQuery(table, numericFilters)
  if (table === 'token_analytics' && filter === 'recent-tokens') {
    const rows = await queryClickhouse<{ total: string }>(
      `SELECT count() AS total
       FROM token_analytics AS t FINAL
       INNER JOIN (
         SELECT contract, chain
         FROM token_market_health FINAL
         WHERE chain = {chain:String}
           AND healthy = 1
           AND checked_at >= now() - toIntervalMinute({maxAgeMinutes:UInt16})
       ) AS h ON h.chain = t.chain AND h.contract = t.contract
       WHERE t.chain = {chain:String}
         AND t.period_days = {periodDays:UInt16}
         AND t.launched_at >= now() - toIntervalDay({maxAgeDays:UInt16})
         AND t.churn_qualified = 1${numeric.sql}`,
      {
        chain,
        periodDays,
        maxAgeDays: config.worker.alphaMaxTokenAgeDays,
        maxAgeMinutes: config.worker.tokenMarketHealthMaxAgeMinutes,
        minAgeDays: config.worker.alphaMinTokenAgeDays,
        ...numeric.params,
      }
    )
    return Number(rows[0]?.total ?? 0)
  }

  const rows = await queryClickhouse<{ total: string }>(
    `SELECT count() AS total FROM ${table} FINAL
     WHERE chain = {chain:String} AND period_days = {periodDays:UInt16}${analyticsFilter(filter)}${numeric.sql}`,
    { chain, periodDays, maxAgeDays: config.worker.alphaMaxTokenAgeDays, minQualifiedTokens: config.worker.walletMinQualifiedTokens, ...numeric.params }
  )
  return Number(rows[0]?.total ?? 0)
}

export async function queryClickhousePaginated<T>(opts: ClickhouseListQuery): Promise<T[]> {
  const { table, chain, periodDays, sortColumn, sortOrder, limit, offset, filter, numericFilters } = opts
  const numeric = numericFilterQuery(table, numericFilters)

  if (table === 'token_analytics' && filter === 'recent-tokens') {
    return queryClickhouse<T>(
      `SELECT
         t.name AS name,
         t.symbol AS symbol,
         t.image_url AS image_url,
         t.contract AS contract,
         h.price AS price,
         h.market_cap AS market_cap,
         h.price_change_24h AS change_pct,
         h.volume_24h AS volume,
         t.holders AS holders,
         h.liquidity AS liquidity,
         t.launched_at AS launched_at,
         t.age_days AS age_days,
         t.alpha_score AS alpha_score,
         t.smart_wallet_buyers AS smart_wallet_buyers,
         t.smart_money_net_flow AS smart_money_net_flow,
         t.buy_acceleration AS buy_acceleration,
         t.qualified_wallet_buyers AS qualified_wallet_buyers,
         t.fresh_wallet_buyers AS fresh_wallet_buyers,
         t.fresh_wallet_share AS fresh_wallet_share,
         t.evidence_tier AS evidence_tier,
         t.real_buyers AS real_buyers,
         t.independent_buyers AS independent_buyers,
         t.net_inflow_usd AS net_inflow_usd,
         t.retention_rate AS retention_rate,
         t.demand_persistence AS demand_persistence,
         t.sniper_share AS sniper_share,
         t.top_buyer_share AS top_buyer_share,
         t.wash_ratio AS wash_ratio,
         t.wealthy_holders AS wealthy_holders,
         t.median_holder_wealth_usd AS median_holder_wealth_usd,
         t.enriched_holders AS enriched_holders,
         t.churn AS churn,
         t.unique_wallet_24h AS unique_wallet_24h,
         t.buy_sell_ratio AS buy_sell_ratio,
         arrayDistinct(arrayConcat(t.risk_flags, h.risk_flags)) AS risk_flags
       FROM token_analytics AS t FINAL
       INNER JOIN (
         SELECT *
         FROM token_market_health FINAL
         WHERE chain = {chain:String}
           AND healthy = 1
           AND checked_at >= now() - toIntervalMinute({maxAgeMinutes:UInt16})
       ) AS h ON h.chain = t.chain AND h.contract = t.contract
       WHERE t.chain = {chain:String}
         AND t.period_days = {periodDays:UInt16}
         AND t.launched_at >= now() - toIntervalDay({maxAgeDays:UInt16})
         AND t.churn_qualified = 1${numeric.sql}
       ORDER BY ${sortColumn} ${sortOrder === 'asc' ? 'ASC' : 'DESC'},
                t.independent_buyers DESC,
                h.volume_24h DESC
       LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
      {
        chain,
        periodDays,
        limit,
        offset,
        maxAgeDays: config.worker.alphaMaxTokenAgeDays,
        maxAgeMinutes: config.worker.tokenMarketHealthMaxAgeMinutes,
        minAgeDays: config.worker.alphaMinTokenAgeDays,
        ...numeric.params,
      }
    )
  }

  return queryClickhouse<T>(
    `SELECT * FROM ${table} FINAL
     WHERE chain = {chain:String} AND period_days = {periodDays:UInt16}${analyticsFilter(filter)}${numeric.sql}
     ORDER BY ${sortColumn} ${sortOrder === 'asc' ? 'ASC' : 'DESC'}
     LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
    { chain, periodDays, limit, offset, maxAgeDays: config.worker.alphaMaxTokenAgeDays, minQualifiedTokens: config.worker.walletMinQualifiedTokens, ...numeric.params }
  )
}
