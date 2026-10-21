import { config } from '../config'
import {
  aggregateTokenPerformance,
  scoreToken,
  scoreWalletReputation,
  type EvidenceTier,
  type TokenPerformance,
  type TradeForPerformance,
} from '../lib/alpha-scoring'
import { evaluateTokenSafety } from '../lib/token-safety'
import { isIndependentBuyer, isRealBuyer, normalizeTraderTags } from '../lib/wallet-quality'
import { allPeriodConfigs } from '../lib/periods'
import { getTokenOverview } from '../services/birdeye'
import { insertClickhouse, queryClickhouse } from '../services/clickhouse'
import { getRawTransactionsForAddress, normalizeRawTokenSwap, type NormalizedSwap } from '../services/helius'

interface LaunchRow {
  contract: string
  chain: string
  name: string
  symbol: string
  image_url: string
  launched_at: string
  price: number
  market_cap: number
  volume_24h: number
  liquidity: number
  holders: number
  price_change_24h: number
}

interface TradeRow {
  chain: string
  contract: string
  wallet_address: string
  side: 'buy' | 'sell'
  token_amount: number
  quote_usd: number
  block_time: string
  minutes_after_launch: number
  suspicious: number
}

interface PerformanceScoreRow {
  wallet_address: string
  contract: string
  buy_usd: number
  sell_usd: number
  last_trade_at: string
  is_fresh_wallet: number
  trader_tags: string[]
  wallet_net_worth: number
}

interface MarketHealthRow {
  contract: string
  price: number
  market_cap: number
  fdv: number
  liquidity: number
  volume_24h: number
  price_change_24h: number
  pair_count: number
  healthy: number
  risk_flags: string[]
  checked_at: string
}

interface CheckpointRow {
  cursor: string
  last_block_time: string
  backfill_complete: number
}

function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().replace('T', ' ').slice(0, 19)
}

function timestamp(value: string): number {
  const normalized = value.includes('T') || value.endsWith('Z') ? value : `${value.replace(' ', 'T')}Z`
  return Math.floor(new Date(normalized).getTime() / 1000)
}

/**
 * Launches worth ingesting trades for: the churn-qualified token list.
 *
 * Ingestion previously targeted an age window, which meant the wallet data described a different
 * set of tokens than the product surfaces — none of the 22 churn-qualified tokens had any wallet
 * performance rows. Sourcing from the same list the site ranks keeps wallets and tokens coherent:
 * a wallet is interesting because it traded tokens we consider real.
 */
async function getRecentLaunches(chain: string): Promise<LaunchRow[]> {
  return queryClickhouse<LaunchRow>(
    `SELECT l.* FROM token_launches AS l FINAL
     INNER JOIN (
       SELECT DISTINCT contract
       FROM token_analytics FINAL
       WHERE chain = {chain:String} AND churn_qualified = 1
     ) AS q ON q.contract = l.contract
     WHERE l.chain = {chain:String}
       AND l.launched_at >= now() - toIntervalDay({maxAgeDays:UInt16})
     ORDER BY l.launched_at DESC`,
    { chain, maxAgeDays: config.worker.alphaMaxTokenAgeDays }
  )
}

async function getCheckpoint(worker: string, chain: string, entityKey: string): Promise<CheckpointRow | null> {
  const rows = await queryClickhouse<CheckpointRow>(
    `SELECT cursor, last_block_time, backfill_complete
     FROM worker_checkpoints FINAL
     WHERE worker = {worker:String} AND chain = {chain:String} AND entity_key = {entityKey:String}
     LIMIT 1`,
    { worker, chain, entityKey }
  )
  return rows[0] ?? null
}

async function saveCheckpoint(
  worker: string,
  chain: string,
  entityKey: string,
  cursor: string,
  lastBlockTime: number,
  backfillComplete: boolean
): Promise<void> {
  await insertClickhouse('worker_checkpoints', [
    {
      worker,
      chain,
      entity_key: entityKey,
      cursor,
      last_block_time: formatDate(lastBlockTime || 0),
      backfill_complete: backfillComplete ? 1 : 0,
      updated_at: formatDate(Math.floor(Date.now() / 1000)),
    },
  ])
}

/**
 * v2 ingestion reads raw transactions oldest first from the last block time it stored. v1 read
 * the Enhanced API newest first and, once a token was complete, stopped at the page cap without
 * remembering where: every swap between that point and the previous run was skipped for good.
 */
const INGEST_WORKER = 'helius_launch_trades_v2'
const LEGACY_INGEST_WORKER = 'helius_launch_trades'

/**
 * Picks the next launches to ingest, never-ingested first, then least recently ingested.
 *
 * The previous implementation stored a positional cursor into a list sorted by launch time. Every
 * run inserted newer launches at the front, shifting every index, so the cursor kept landing near
 * the top and re-ingesting the freshest tokens — 245 of 296 launches had never been ingested at
 * all. Ordering by ingestion recency is stable regardless of how the launch list changes.
 */
async function selectLaunchBatch(chain: string, launches: LaunchRow[]): Promise<LaunchRow[]> {
  if (launches.length <= config.worker.alphaTokensPerRun) return launches

  const seen = await queryClickhouse<{ entity_key: string; updated_at: string }>(
    `SELECT entity_key, updated_at FROM worker_checkpoints FINAL
     WHERE worker = {worker:String} AND chain = {chain:String}`,
    { worker: INGEST_WORKER, chain }
  )
  const lastIngested = new Map(seen.map((row) => [row.entity_key, timestamp(row.updated_at)]))

  return [...launches]
    .sort((a, b) => (lastIngested.get(a.contract) ?? 0) - (lastIngested.get(b.contract) ?? 0))
    .slice(0, config.worker.alphaTokensPerRun)
}

/** Signatures already stored for this token within the given time range. */
async function storedSignatures(chain: string, contract: string, from: number, to: number): Promise<Set<string>> {
  const rows = await queryClickhouse<{ signature: string }>(
    `SELECT DISTINCT signature FROM wallet_token_trades
     WHERE chain = {chain:String} AND contract = {contract:String}
       AND block_time >= toDateTime({from:UInt32}) AND block_time <= toDateTime({to:UInt32})`,
    { chain, contract, from, to }
  )
  return new Set(rows.map((row) => row.signature))
}

/** Where a token's ingestion resumes: its v2 checkpoint, else v1's if v1 had finished cleanly. */
async function ingestStart(launch: LaunchRow, launchTime: number): Promise<number> {
  const checkpoint = await getCheckpoint(INGEST_WORKER, launch.chain, launch.contract)
  if (checkpoint) return Math.max(timestamp(checkpoint.last_block_time), launchTime)
  // A v1 backfill that never finished left a gap below its cursor, so it restarts from launch;
  // signature deduplication keeps the overlap from being stored twice.
  const legacy = await getCheckpoint(LEGACY_INGEST_WORKER, launch.chain, launch.contract)
  return legacy?.backfill_complete ? Math.max(timestamp(legacy.last_block_time), launchTime) : launchTime
}

async function ingestLaunchTrades(launch: LaunchRow, solUsdPrice: number): Promise<void> {
  const launchTime = timestamp(launch.launched_at)
  const from = await ingestStart(launch, launchTime)
  const pageSize = config.worker.alphaTransactionPageSize
  let paginationToken: string | null = null
  let newestSeen = from
  let reachedEnd = false

  for (let pageNumber = 0; pageNumber < config.worker.alphaBackfillPagesPerToken; pageNumber++) {
    const page = await getRawTransactionsForAddress(launch.contract, {
      sortOrder: 'asc',
      limit: pageSize,
      fromBlockTime: from,
      paginationToken,
    })
    const swaps = page.data
      .map((tx) => normalizeRawTokenSwap(tx, launch.contract, launchTime, solUsdPrice))
      .filter((swap): swap is NormalizedSwap => swap !== null)
    if (swaps.length > 0) {
      const times = swaps.map((swap) => swap.blockTime)
      const stored = await storedSignatures(launch.chain, launch.contract, Math.min(...times), Math.max(...times))
      const fresh = swaps.filter((swap) => !stored.has(swap.signature))
      if (fresh.length > 0) {
        await insertClickhouse(
          'wallet_token_trades',
          fresh.map((trade) => ({
            chain: launch.chain,
            contract: trade.contract,
            wallet_address: trade.walletAddress,
            signature: trade.signature,
            event_index: trade.eventIndex,
            side: trade.side,
            token_amount: trade.tokenAmount,
            quote_amount: trade.quoteAmount,
            quote_symbol: trade.quoteSymbol,
            quote_usd: trade.quoteUsd,
            block_time: formatDate(trade.blockTime),
            minutes_after_launch: trade.minutesAfterLaunch,
            suspicious: trade.suspicious ? 1 : 0,
            ingested_at: formatDate(Math.floor(Date.now() / 1000)),
          }))
        )
      }
    }

    for (const tx of page.data) newestSeen = Math.max(newestSeen, Number(tx.blockTime ?? 0))
    if (!page.paginationToken || page.data.length < pageSize) {
      reachedEnd = true
      break
    }
    paginationToken = page.paginationToken
  }

  // Resuming from the newest second seen re-reads that second next time, which the signature
  // check absorbs. Stopping at the page cap loses nothing: the next visit continues from here.
  await saveCheckpoint(INGEST_WORKER, launch.chain, launch.contract, '', newestSeen, reachedEnd)
}

export async function syncAlphaTradesForChain(chain: string): Promise<void> {
  if (chain !== 'solana' || !config.helius.apiKey) {
    console.warn(`[sync-alpha] ${chain} requires a Helius API key; skipping`)
    return
  }
  const launches = await getRecentLaunches(chain)
  if (launches.length === 0) {
    console.warn(`[sync-alpha] No ${chain} launches inside the maturity window`)
    return
  }
  const batch = await selectLaunchBatch(chain, launches)
  const sol = await getTokenOverview('So11111111111111111111111111111111111111112', chain)
  const solUsdPrice = sol?.price && sol.price > 0 ? sol.price : config.worker.solUsdPriceFallback
  console.log(`[sync-alpha] Ingesting trades for ${batch.length}/${launches.length} mature launches`)
  for (const launch of batch) {
    try {
      await ingestLaunchTrades(launch, solUsdPrice)
    } catch (error) {
      console.error(`[sync-alpha] Failed trade ingestion for ${launch.contract}:`, error)
    }
  }
}

export async function syncAllAlphaTrades(): Promise<void> {
  for (const chain of config.worker.syncChains) await syncAlphaTradesForChain(chain)
}

export async function refreshAllWalletTokenPerformance(): Promise<void> {
  for (const chain of config.worker.syncChains) await refreshWalletTokenPerformance(chain)
}

function toPerformanceTrade(row: TradeRow): TradeForPerformance {
  return {
    side: row.side,
    tokenAmount: Number(row.token_amount),
    quoteUsd: Number(row.quote_usd),
    blockTime: timestamp(row.block_time),
    minutesAfterLaunch: Number(row.minutes_after_launch),
    suspicious: Boolean(row.suspicious),
  }
}

export async function refreshWalletTokenPerformance(chain: string): Promise<void> {
  const launches = await getRecentLaunches(chain)
  if (launches.length === 0) return
  const launchMap = new Map(launches.map((launch) => [launch.contract, launch]))
  const trades = await queryClickhouse<TradeRow>(
    `SELECT * FROM wallet_token_trades FINAL
     WHERE chain = {chain:String}
       AND block_time >= now() - toIntervalDay({maxAgeDays:UInt16})`,
    { chain, maxAgeDays: config.worker.alphaMaxTokenAgeDays }
  )
  const now = Math.floor(Date.now() / 1000)

  for (const period of allPeriodConfigs()) {
    const cutoff = now - Math.min(period.days, config.worker.alphaMaxTokenAgeDays) * 86_400
    const groups = new Map<string, TradeRow[]>()
    for (const trade of trades) {
      if (timestamp(trade.block_time) < cutoff || !launchMap.has(trade.contract)) continue
      const key = `${trade.wallet_address}:${trade.contract}`
      const current = groups.get(key) ?? []
      current.push(trade)
      groups.set(key, current)
    }

    const rows: Record<string, unknown>[] = []
    for (const [key, groupedTrades] of groups) {
      const separator = key.indexOf(':')
      const wallet = key.slice(0, separator)
      const contract = key.slice(separator + 1)
      const launch = launchMap.get(contract)
      if (!launch) continue
      const performance = aggregateTokenPerformance(
        contract,
        timestamp(launch.launched_at),
        Number(launch.price),
        groupedTrades.map(toPerformanceTrade)
      )
      if (!performance) continue
      rows.push(performanceRow(chain, period.days, wallet, launch, performance, now))
    }
    await insertClickhouse('wallet_token_performance', rows)
  }
}

function performanceRow(
  chain: string,
  periodDays: number,
  wallet: string,
  launch: LaunchRow,
  performance: TokenPerformance,
  now: number
): Record<string, unknown> {
  return {
    chain,
    period_days: periodDays,
    wallet_address: wallet,
    contract: performance.contract,
    launched_at: launch.launched_at,
    first_buy_at: formatDate(performance.firstBuyAt),
    last_trade_at: formatDate(performance.lastTradeAt),
    entry_delay_minutes: Math.round(performance.entryDelayMinutes),
    buy_usd: performance.buyUsd,
    sell_usd: performance.sellUsd,
    bought_amount: performance.boughtAmount,
    sold_amount: performance.soldAmount,
    remaining_amount: performance.remainingAmount,
    realized_pnl: performance.realizedPnl,
    unrealized_pnl: performance.unrealizedPnl,
    roi_pct: performance.roiPct,
    trade_count: performance.tradeCount,
    suspicious_trade_count: performance.suspiciousTradeCount,
    updated_at: formatDate(now),
  }
}

interface TokenAggregateRow {
  contract: string
  recent_buy_usd: number
  previous_buy_usd: number
  distinct_sellers: number
  distinct_traders: number
  buy_hours: number
  span_hours: number
  trades: number
  suspicious_trades: number
}

interface BuyerAggregateRow {
  contract: string
  wallet_address: string
  buy_usd: number
  sell_usd: number
  bought_amount: number
  sold_amount: number
  entry_minutes: number
  trades: number
  suspicious_trades: number
}

interface WalletBreadthRow {
  wallet_address: string
  distinct_tokens: number
}

interface ReputationPerformanceRow {
  wallet_address: string
  contract: string
  buy_usd: number
  sell_usd: number
  realized_pnl: number
  unrealized_pnl: number
  roi_pct: number
  entry_delay_minutes: number
  trade_count: number
  suspicious_trade_count: number
  is_fresh_wallet: number
  trader_tags: string[]
}

/** Minutes after launch within which a first buy counts as sniping rather than genuine demand. */
const SNIPER_WINDOW_MINUTES = 5

function toPerformance(row: ReputationPerformanceRow): TokenPerformance {
  return {
    contract: row.contract,
    launchedAt: 0,
    firstBuyAt: 0,
    lastTradeAt: 0,
    entryDelayMinutes: Number(row.entry_delay_minutes),
    buyUsd: Number(row.buy_usd),
    sellUsd: Number(row.sell_usd),
    boughtAmount: 0,
    soldAmount: 0,
    remainingAmount: 0,
    realizedPnl: Number(row.realized_pnl),
    unrealizedPnl: Number(row.unrealized_pnl),
    roiPct: Number(row.roi_pct),
    tradeCount: Number(row.trade_count),
    suspiciousTradeCount: Number(row.suspicious_trade_count),
  }
}

/**
 * Alpha scoring v2.
 *
 * Layer 0 assigns an evidence tier, Layer 1 applies hard safety gates, Layer 2 derives real demand
 * from raw trades, Layer 3 weights that demand by out-of-sample wallet reputation, Layer 4
 * composes the score. Reads only ClickHouse — no external API calls — so it is free to re-run.
 */
export async function refreshTokenScores(chain: string): Promise<void> {
  const launches = await getRecentLaunches(chain)
  if (launches.length === 0) return
  const now = Math.floor(Date.now() / 1000)

  const healthRows = await queryClickhouse<MarketHealthRow>(
    `SELECT contract, price, market_cap, fdv, liquidity, volume_24h, price_change_24h,
            pair_count, healthy, risk_flags, checked_at
     FROM token_market_health FINAL
     WHERE chain = {chain:String}`,
    { chain }
  )
  const healthByContract = new Map(healthRows.map((row) => [row.contract, row]))

  // Token-level trade shape: pace, breadth and wash pressure.
  const tokenAggregates = await queryClickhouse<TokenAggregateRow>(
    `SELECT
       contract,
       sumIf(quote_usd, side = 'buy' AND block_time >= now() - INTERVAL 1 DAY) AS recent_buy_usd,
       sumIf(quote_usd, side = 'buy' AND block_time < now() - INTERVAL 1 DAY
             AND block_time >= now() - INTERVAL 2 DAY) AS previous_buy_usd,
       uniqExactIf(wallet_address, side = 'sell') AS distinct_sellers,
       uniqExact(wallet_address) AS distinct_traders,
       uniqExactIf(toStartOfHour(block_time), side = 'buy') AS buy_hours,
       dateDiff('hour', min(block_time), max(block_time)) + 1 AS span_hours,
       count() AS trades,
       countIf(suspicious = 1) AS suspicious_trades
     FROM wallet_token_trades
     WHERE chain = {chain:String}
     GROUP BY contract`,
    { chain }
  )
  const aggregateByContract = new Map(tokenAggregates.map((row) => [row.contract, row]))

  // Per wallet, per token: the position each wallet actually built.
  const buyerRows = await queryClickhouse<BuyerAggregateRow>(
    `SELECT
       contract,
       wallet_address,
       sumIf(quote_usd, side = 'buy') AS buy_usd,
       sumIf(quote_usd, side = 'sell') AS sell_usd,
       sumIf(token_amount, side = 'buy') AS bought_amount,
       sumIf(token_amount, side = 'sell') AS sold_amount,
       minIf(minutes_after_launch, side = 'buy') AS entry_minutes,
       count() AS trades,
       countIf(suspicious = 1) AS suspicious_trades
     FROM wallet_token_trades
     WHERE chain = {chain:String}
     GROUP BY contract, wallet_address`,
    { chain }
  )
  const buyersByContract = new Map<string, BuyerAggregateRow[]>()
  for (const row of buyerRows) {
    const list = buyersByContract.get(row.contract) ?? []
    list.push(row)
    buyersByContract.set(row.contract, list)
  }

  // How many distinct tokens each wallet has touched, to separate participants from burners.
  const breadthRows = await queryClickhouse<WalletBreadthRow>(
    `SELECT wallet_address, uniqExact(contract) AS distinct_tokens
     FROM wallet_token_trades
     WHERE chain = {chain:String}
     GROUP BY wallet_address`,
    { chain }
  )
  const breadthByWallet = new Map(breadthRows.map((row) => [row.wallet_address, Number(row.distinct_tokens)]))

  // Helius-enriched balances for top holders (Birdeye returns 0 on the free plan).
  const wealthRows = await queryClickhouse<{ wallet_address: string; net_worth_usd: number }>(
    `SELECT wallet_address, net_worth_usd FROM wallet_wealth FINAL
     WHERE chain = {chain:String}
       AND checked_at >= now() - toIntervalHour({ttlHours:UInt16})`,
    { chain, ttlHours: config.worker.alphaWealthTtlHours }
  )
  const wealthByWallet = new Map(wealthRows.map((row) => [row.wallet_address, Number(row.net_worth_usd)]))

  // Which tokens have had their trade history fully ingested. Buyer counts on a partially
  // backfilled token are lower bounds, so every ratio built on them flatters the token.
  const backfillRows = await queryClickhouse<{ entity_key: string; backfill_complete: number }>(
    `SELECT entity_key, backfill_complete FROM worker_checkpoints FINAL
     WHERE worker = {worker:String} AND chain = {chain:String}`,
    { chain }
  )
  const backfillComplete = new Set(
    backfillRows.filter((row) => Number(row.backfill_complete) === 1).map((row) => row.entity_key)
  )

  for (const period of allPeriodConfigs()) {
    // Reputation inputs. Grouped per wallet so the scored token can be excluded per-token below.
    const performanceRows = await queryClickhouse<ReputationPerformanceRow>(
      `SELECT
         wallet_address, contract, buy_usd, sell_usd, realized_pnl, unrealized_pnl,
         roi_pct, entry_delay_minutes, trade_count, suspicious_trade_count,
         is_fresh_wallet, trader_tags
       FROM wallet_token_performance FINAL
       WHERE chain = {chain:String} AND period_days = {periodDays:UInt16}`,
      { chain, periodDays: period.days }
    )
    const performanceByWallet = new Map<string, ReputationPerformanceRow[]>()
    const freshByWallet = new Map<string, boolean>()
    const tagsByWallet = new Map<string, string[]>()
    for (const row of performanceRows) {
      const list = performanceByWallet.get(row.wallet_address) ?? []
      list.push(row)
      performanceByWallet.set(row.wallet_address, list)
      if (Number(row.is_fresh_wallet) === 1) freshByWallet.set(row.wallet_address, true)
      if (row.trader_tags?.length) tagsByWallet.set(row.wallet_address, normalizeTraderTags(row.trader_tags))
    }

    const updatedAt = formatDate(now)
    const rows = launches.map((launch) => {
      const health = healthByContract.get(launch.contract)
      const healthAgeMinutes = health ? (now - timestamp(health.checked_at)) / 60 : Number.POSITIVE_INFINITY
      const marketHealthFresh =
        Boolean(health) && healthAgeMinutes <= config.worker.tokenMarketHealthMaxAgeMinutes
      const marketHealthy = Boolean(health?.healthy)
      const liveLiquidity = health ? Number(health.liquidity) : Number(launch.liquidity)
      const liveMarketCap = health ? Number(health.market_cap) : Number(launch.market_cap)
      const livePrice = health ? Number(health.price) : Number(launch.price)
      const liveVolume = health ? Number(health.volume_24h) : Number(launch.volume_24h)
      const liveChange = health ? Number(health.price_change_24h) : Number(launch.price_change_24h)

      const aggregate = aggregateByContract.get(launch.contract)
      const tokenBuyers = buyersByContract.get(launch.contract) ?? []

      // Layer 0: what do we actually know about this token?
      const tradeCount = aggregate ? Number(aggregate.trades) : 0
      const distinctTraders = aggregate ? Number(aggregate.distinct_traders) : 0
      // 'verified' additionally requires a COMPLETE backfill: without it the buyer count is a
      // lower bound, and treating it as final is what let a bundle score 77.4 on 70 observed
      // buyers when its real trader base was the thing under question.
      const isComplete = backfillComplete.has(launch.contract)
      const evidenceTier: EvidenceTier =
        isComplete &&
        tradeCount >= config.worker.alphaMinTradesForEvidence &&
        distinctTraders >= config.worker.alphaMinTradersForEvidence
          ? 'verified'
          : marketHealthy && marketHealthFresh
            ? 'partial'
            : 'unverified'

      // Layer 2: real demand, from the positions wallets actually built.
      const totalBuyUsd = tokenBuyers.reduce((sum, row) => sum + Number(row.buy_usd), 0)
      const sniperBuyUsd = tokenBuyers
        .filter((row) => Number(row.entry_minutes) <= SNIPER_WINDOW_MINUTES)
        .reduce((sum, row) => sum + Number(row.buy_usd), 0)
      const sniperShare = totalBuyUsd > 0 ? sniperBuyUsd / totalBuyUsd : 0
      const topBuyerShare =
        totalBuyUsd > 0
          ? tokenBuyers
              .map((row) => Number(row.buy_usd))
              .sort((a, b) => b - a)
              .slice(0, 3)
              .reduce((sum, value) => sum + value, 0) / totalBuyUsd
          : 0
      const washRatio =
        aggregate && Number(aggregate.trades) > 0
          ? Number(aggregate.suspicious_trades) / Number(aggregate.trades)
          : 0

      const realBuyers: BuyerAggregateRow[] = []
      const independentBuyers: BuyerAggregateRow[] = []
      let freshRealBuyers = 0
      for (const row of tokenBuyers) {
        const netFlowUsd = Number(row.buy_usd) - Number(row.sell_usd)
        const walletWash = Number(row.trades) > 0 ? Number(row.suspicious_trades) / Number(row.trades) : 0
        const isFresh = freshByWallet.get(row.wallet_address) ?? false
        const candidate = {
          tags: tagsByWallet.get(row.wallet_address) ?? [],
          netFlowUsd,
          isFresh,
          isSniper: Number(row.entry_minutes) <= SNIPER_WINDOW_MINUTES,
          // Exclude this token from the wallet's breadth so a single-token wallet reads as 1, not 2.
          distinctOtherTokens: Math.max((breadthByWallet.get(row.wallet_address) ?? 1) - 1, 0),
          washRatio: walletWash,
          minPositionUsd: config.worker.alphaMinBuyerPositionUsd,
        }
        if (isFresh && netFlowUsd > 0) freshRealBuyers += 1
        if (!isRealBuyer(candidate)) continue
        realBuyers.push(row)
        if (isIndependentBuyer(candidate, config.worker.alphaMinOtherTokens)) {
          independentBuyers.push(row)
        }
      }

      const netInflowUsd = realBuyers.reduce(
        (sum, row) => sum + (Number(row.buy_usd) - Number(row.sell_usd)),
        0
      )
      const retainedBuyers = realBuyers.filter(
        (row) => Number(row.bought_amount) > Number(row.sold_amount)
      ).length
      const retentionRate = realBuyers.length > 0 ? retainedBuyers / realBuyers.length : 0
      const spanHours = aggregate ? Math.max(Number(aggregate.span_hours), 1) : 1
      const demandPersistence = aggregate
        ? Math.min(Number(aggregate.buy_hours) / Math.min(spanHours, 12), 1)
        : 0
      const freshBuyerShare =
        realBuyers.length + freshRealBuyers > 0
          ? freshRealBuyers / (realBuyers.length + freshRealBuyers)
          : 0

      // Holder wealth: sample the largest real positions and check they are substantial wallets.
      const topHolders = [...realBuyers]
        .sort(
          (a, b) =>
            Number(b.buy_usd) - Number(b.sell_usd) - (Number(a.buy_usd) - Number(a.sell_usd))
        )
        .slice(0, config.worker.alphaTopHoldersToEnrich)
      const holderWealths = topHolders
        .map((row) => wealthByWallet.get(row.wallet_address))
        .filter((value): value is number => value !== undefined)
      const wealthyHolders = holderWealths.filter(
        (value) => value >= config.worker.alphaWealthyHolderMinUsd
      ).length
      const sortedWealth = [...holderWealths].sort((a, b) => a - b)
      const medianHolderWealth =
        sortedWealth.length > 0 ? sortedWealth[Math.floor(sortedWealth.length / 2)] : 0

      // Layer 3: weight inflow by each buyer's reputation, computed WITHOUT this token.
      let reputationWeightedInflow = 0
      for (const row of realBuyers) {
        const history = performanceByWallet.get(row.wallet_address) ?? []
        const outOfSample = history.filter((item) => item.contract !== launch.contract)
        const { reputationScore } = scoreWalletReputation(
          outOfSample.map(toPerformance),
          config.worker.alphaMinClosedPositions
        )
        reputationWeightedInflow +=
          (Number(row.buy_usd) - Number(row.sell_usd)) * (reputationScore / 100)
      }

      // Layer 1: hard safety gates.
      const safety = evaluateTokenSafety({
        liquidity: liveLiquidity,
        marketCap: liveMarketCap,
        fdv: health ? Number(health.fdv) : 0,
        volume24h: liveVolume,
        pairCount: health ? Number(health.pair_count) : 0,
        marketHealthy,
        marketHealthFresh,
        distinctBuyers: evidenceTier === 'verified' ? tokenBuyers.length : undefined,
        distinctSellers:
          evidenceTier === 'verified' && aggregate ? Number(aggregate.distinct_sellers) : undefined,
        sniperShare: evidenceTier === 'verified' ? sniperShare : undefined,
        topBuyerShare: evidenceTier === 'verified' ? topBuyerShare : undefined,
        washRatio: evidenceTier === 'verified' ? washRatio : undefined,
      })

      const recentBuyUsd = aggregate ? Number(aggregate.recent_buy_usd) : 0
      const previousBuyUsd = aggregate ? Number(aggregate.previous_buy_usd) : 0
      const buyAcceleration = Math.max(
        -1,
        Math.min(5, (recentBuyUsd - previousBuyUsd) / Math.max(previousBuyUsd, 100))
      )

      // Layer 4: composite.
      const scored = scoreToken({
        ageDays: Math.max(0, (now - timestamp(launch.launched_at)) / 86_400),
        liquidity: liveLiquidity,
        marketCap: liveMarketCap,
        evidenceTier,
        safetyFailed: !safety.safe,
        buyAcceleration,
        minRealBuyers: config.worker.alphaMinRealBuyers,
        minWealthyHolders: config.worker.alphaMinWealthyHolders,
        minIndependentShare: config.worker.alphaMinIndependentShare,
        maxMcapPerBuyer: config.worker.alphaMaxMcapPerBuyer,
        demand: {
          realBuyers: realBuyers.length,
          independentBuyers: independentBuyers.length,
          netInflowUsd,
          reputationWeightedInflow,
          retentionRate,
          demandPersistence,
          topBuyerShare,
          sniperShare,
          washRatio,
          freshBuyerShare,
          enrichedHolders: holderWealths.length,
          wealthyHolders,
        },
      })

      const riskFlags = [
        ...new Set([...(health?.risk_flags ?? []), ...safety.riskFlags, ...scored.riskFlags]),
      ]

      return {
        contract: launch.contract,
        chain,
        period_days: period.days,
        name: launch.name,
        symbol: launch.symbol,
        image_url: launch.image_url,
        price: livePrice,
        market_cap: liveMarketCap,
        change_pct: liveChange,
        volume: liveVolume,
        liquidity: liveLiquidity,
        holders: Number(launch.holders),
        launched_at: launch.launched_at,
        age_days: Math.max(0, Math.floor((now - timestamp(launch.launched_at)) / 86_400)),
        alpha_score: scored.alphaScore,
        evidence_tier: evidenceTier,
        safety_failed: safety.safe ? 0 : 1,
        real_buyers: realBuyers.length,
        independent_buyers: independentBuyers.length,
        net_inflow_usd: netInflowUsd,
        reputation_weighted_inflow: reputationWeightedInflow,
        retention_rate: retentionRate,
        demand_persistence: demandPersistence,
        sniper_share: sniperShare,
        top_buyer_share: topBuyerShare,
        wash_ratio: washRatio,
        trade_count: tradeCount,
        distinct_traders: distinctTraders,
        wealthy_holders: wealthyHolders,
        median_holder_wealth_usd: medianHolderWealth,
        enriched_holders: holderWealths.length,
        backfill_complete: isComplete ? 1 : 0,
        mcap_per_buyer: realBuyers.length > 0 ? liveMarketCap / realBuyers.length : 0,
        // Kept for backward compatibility with existing readers of the v1 columns.
        smart_wallet_buyers: independentBuyers.length,
        smart_money_net_flow: netInflowUsd,
        buy_acceleration: buyAcceleration,
        qualified_wallet_buyers: realBuyers.length,
        fresh_wallet_buyers: freshRealBuyers,
        fresh_wallet_share: freshBuyerShare,
        risk_flags: riskFlags,
        updated_at: updatedAt,
      }
    })

    await insertClickhouse('token_analytics', rows)
    const scoredCount = rows.filter((row) => row.alpha_score > 0).length
    console.log(
      `[sync-alpha] ${chain}/${period.label}: scored ${scoredCount}/${rows.length} ` +
        `(verified ${rows.filter((r) => r.evidence_tier === 'verified').length}, ` +
        `safety-failed ${rows.filter((r) => r.safety_failed === 1).length})`
    )
  }
}
