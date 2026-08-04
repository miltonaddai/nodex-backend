import { config } from '../config'
import { hasSuspiciousTraderTag, isFreshWallet, normalizeTraderTags } from '../lib/wallet-quality'
import { isValidSolanaAddress } from '../lib/validation'
import { getTokenTopTraders } from '../services/birdeye'
import { insertClickhouse, queryClickhouse } from '../services/clickhouse'

interface CandidateToken {
  contract: string
  launched_at: string
  liquidity: number
  volume_24h: number
  market_cap: number
  alpha_score: number
}

interface RefreshCheckpoint {
  updated_at: string
}

interface WalletHistoryRow {
  wallet_address: string
  first_observed_at: string
  distinct_tokens: number
}

interface TraderPeriod {
  periodDays: 1 | 7 | 30
  timeFrame: '24h' | '7d' | '30d'
  refreshHours: number
  tokenLimit: number
}

function timestamp(value: string): number {
  const normalized = value.includes('T') || value.endsWith('Z') ? value : `${value.replace(' ', 'T')}Z`
  return Math.floor(new Date(normalized).getTime() / 1000)
}

function formatDate(value: number): string {
  return new Date(value * 1000).toISOString().replace('T', ' ').slice(0, 19)
}

async function isDue(chain: string, period: TraderPeriod): Promise<boolean> {
  const rows = await queryClickhouse<RefreshCheckpoint>(
    `SELECT updated_at FROM worker_checkpoints FINAL
     WHERE worker = 'birdeye_top_traders'
       AND chain = {chain:String}
       AND entity_key = {entityKey:String}
     LIMIT 1`,
    { chain, entityKey: period.timeFrame }
  )
  const lastRun = rows[0]?.updated_at ? timestamp(rows[0].updated_at) : 0
  return Date.now() / 1000 - lastRun >= period.refreshHours * 3600
}

async function saveRefreshCheckpoint(chain: string, period: TraderPeriod): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await insertClickhouse('worker_checkpoints', [
    {
      worker: 'birdeye_top_traders',
      chain,
      entity_key: period.timeFrame,
      cursor: '',
      last_block_time: formatDate(now),
      backfill_complete: 1,
      updated_at: formatDate(now),
    },
  ])
}

/** Prefer healthy recent launches so new tokens get evaluated without needing prior alpha. */
async function getTraderCandidateTokens(
  chain: string,
  periodDays: number,
  limit: number
): Promise<CandidateToken[]> {
  return queryClickhouse<CandidateToken>(
    `SELECT
       l.contract AS contract,
       l.launched_at AS launched_at,
       if(h.has_health = 1, h.liquidity, l.liquidity) AS liquidity,
       if(h.has_health = 1, h.volume_24h, l.volume_24h) AS volume_24h,
       if(h.has_health = 1, h.market_cap, l.market_cap) AS market_cap,
       ifNull(a.alpha_score, 0) AS alpha_score
     FROM token_launches AS l FINAL
     LEFT JOIN (
       SELECT
         chain,
         contract,
         liquidity,
         volume_24h,
         market_cap,
         healthy,
         1 AS has_health
       FROM token_market_health FINAL
       WHERE chain = {chain:String}
         AND checked_at >= now() - toIntervalMinute({maxAgeMinutes:UInt16})
     ) AS h ON h.chain = l.chain AND h.contract = l.contract
     LEFT JOIN (
       SELECT contract, alpha_score
       FROM token_analytics FINAL
       WHERE chain = {chain:String}
         AND period_days = {periodDays:UInt16}
     ) AS a ON a.contract = l.contract
     WHERE l.chain = {chain:String}
       AND l.launched_at >= now() - toIntervalDay({maxAgeDays:UInt16})
       AND (
         h.healthy = 1
         OR (
           h.has_health = 0
           AND l.liquidity >= {minLiquidity:Float64}
           AND l.volume_24h >= {minVolume:Float64}
           AND l.market_cap >= {minMarketCap:Float64}
         )
       )
     ORDER BY alpha_score DESC, liquidity DESC, volume_24h DESC, launched_at DESC
     LIMIT {limit:UInt16}`,
    {
      chain,
      periodDays,
      maxAgeDays: config.worker.alphaMaxTokenAgeDays,
      maxAgeMinutes: config.worker.tokenMarketHealthMaxAgeMinutes,
      minLiquidity: config.worker.tokenMinLiquidity,
      minVolume: config.worker.tokenMinVolume,
      minMarketCap: config.worker.tokenMinMarketCap,
      limit,
    }
  )
}

async function getWalletHistory(chain: string, wallets: string[]): Promise<Map<string, WalletHistoryRow>> {
  if (wallets.length === 0) return new Map()
  const rows = await queryClickhouse<WalletHistoryRow>(
    `SELECT
       wallet_address,
       min(first_buy_at) AS first_observed_at,
       uniqExact(contract) AS distinct_tokens
     FROM wallet_token_performance FINAL
     WHERE chain = {chain:String}
       AND wallet_address IN {wallets:Array(String)}
     GROUP BY wallet_address`,
    { chain, wallets }
  )
  return new Map(rows.map((row) => [row.wallet_address, row]))
}

export async function syncTopTradersForChain(chain: string): Promise<void> {
  if (chain !== 'solana' || !config.birdeye.apiKey) return
  const periods: TraderPeriod[] = [
    {
      periodDays: 1,
      timeFrame: '24h',
      refreshHours: config.worker.alphaTopTraders24hRefreshHours,
      tokenLimit: config.worker.alphaTopTraderTokens,
    },
    {
      periodDays: 7,
      timeFrame: '7d',
      refreshHours: config.worker.alphaTopTraders7dRefreshHours,
      tokenLimit: config.worker.alphaTopTraderTokens,
    },
    {
      periodDays: 30,
      timeFrame: '30d',
      refreshHours: config.worker.alphaTopTraders30dRefreshHours,
      tokenLimit: config.worker.alphaTopTraderTokens30d,
    },
  ]

  for (const period of periods) {
    if (!(await isDue(chain, period))) continue
    const tokens = await getTraderCandidateTokens(chain, period.periodDays, period.tokenLimit)
    if (tokens.length === 0) {
      console.warn(`[sync-top-traders] No healthy candidate tokens for ${period.timeFrame}`)
      continue
    }

    const rows: Record<string, unknown>[] = []
    const now = Math.floor(Date.now() / 1000)
    const walletCache = new Map<string, WalletHistoryRow>()

    for (const token of tokens) {
      const launchedAt = timestamp(token.launched_at)
      const traders = await getTokenTopTraders(
        token.contract,
        chain,
        period.timeFrame,
        config.worker.alphaTopTradersPerToken
      )
      const missingHistory = traders
        .map((trader) => trader.owner)
        .filter((owner) => isValidSolanaAddress(owner) && !walletCache.has(owner))
      const history = await getWalletHistory(chain, missingHistory)
      for (const [wallet, row] of history) walletCache.set(wallet, row)

      for (const trader of traders) {
        if (!isValidSolanaAddress(trader.owner) || trader.trades < 1) continue
        const tags = normalizeTraderTags(trader.tags)
        if (hasSuspiciousTraderTag(tags)) continue

        const firstTrade = trader.firstTradeUnixTime || now
        const lastTrade = trader.lastTradeUnixTime || firstTrade
        const historyRow = walletCache.get(trader.owner)
        const firstObservedAt = historyRow ? timestamp(historyRow.first_observed_at) : firstTrade
        const distinctTokens = historyRow
          ? Math.max(Number(historyRow.distinct_tokens), 1)
          : 1
        const fresh = isFreshWallet({
          tags,
          fundingUnixTime: trader.fundingUnixTime,
          firstObservedAt,
          distinctTokenCount: distinctTokens,
          now,
        })
        const realizedPnl =
          trader.realizedPnl || (!trader.unrealizedPnl ? trader.totalPnl : 0)
        const targetPeriods = period.periodDays === 30 ? [30, 365] : [period.periodDays]
        const fundedAt = trader.fundingUnixTime > 0 ? formatDate(trader.fundingUnixTime) : formatDate(0)

        for (const periodDays of targetPeriods) {
          rows.push({
            chain,
            period_days: periodDays,
            wallet_address: trader.owner,
            contract: token.contract,
            launched_at: token.launched_at,
            first_buy_at: formatDate(firstTrade),
            last_trade_at: formatDate(lastTrade),
            entry_delay_minutes: Math.max(0, Math.floor((firstTrade - launchedAt) / 60)),
            buy_usd: trader.volumeBuyUsd,
            sell_usd: trader.volumeSellUsd,
            bought_amount: trader.volumeBuy,
            sold_amount: trader.volumeSell,
            remaining_amount: Math.max(0, trader.holdVolume),
            realized_pnl: realizedPnl,
            unrealized_pnl: trader.unrealizedPnl,
            roi_pct:
              trader.volumeBuyUsd > 0
                ? Math.max(-100, Math.min(1000, (trader.totalPnl / trader.volumeBuyUsd) * 100))
                : 0,
            trade_count: trader.trades,
            suspicious_trade_count: tags.includes('sniper') ? 1 : 0,
            wallet_funded_at: fundedAt,
            wallet_net_worth: trader.netWorth,
            wallet_sol_balance: trader.solBalance,
            trader_tags: tags,
            is_fresh_wallet: fresh ? 1 : 0,
            updated_at: formatDate(now),
          })
        }
      }
    }

    await insertClickhouse('wallet_token_performance', rows)
    await saveRefreshCheckpoint(chain, period)
    console.log(
      `[sync-top-traders] Wrote ${rows.length} ${period.timeFrame} trader outcomes from ${tokens.length} healthy tokens`
    )
  }
}

export async function syncAllTopTraders(): Promise<void> {
  for (const chain of config.worker.syncChains) await syncTopTradersForChain(chain)
}
