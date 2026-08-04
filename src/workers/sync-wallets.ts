import { config } from '../config'
import { scoreWallet, scoreWalletReputation, type TokenPerformance } from '../lib/alpha-scoring'
import { allPeriodConfigs } from '../lib/periods'
import { insertClickhouse, queryClickhouse } from '../services/clickhouse'
import { enrichSolanaWalletBalanceUsd, getSolanaWalletTokenCount } from '../services/helius'

interface PerformanceRow {
  wallet_address: string
  contract: string
  launched_at: string
  first_buy_at: string
  last_trade_at: string
  entry_delay_minutes: number
  buy_usd: number
  sell_usd: number
  bought_amount: number
  sold_amount: number
  remaining_amount: number
  realized_pnl: number
  unrealized_pnl: number
  roi_pct: number
  trade_count: number
  suspicious_trade_count: number
}

function formatNow(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

function asTimestamp(value: string): number {
  const normalized = value.includes('T') || value.endsWith('Z') ? value : `${value.replace(' ', 'T')}Z`
  return Math.floor(new Date(normalized).getTime() / 1000)
}

function asPerformance(row: PerformanceRow): TokenPerformance {
  return {
    contract: row.contract,
    launchedAt: asTimestamp(row.launched_at),
    firstBuyAt: asTimestamp(row.first_buy_at),
    lastTradeAt: asTimestamp(row.last_trade_at),
    entryDelayMinutes: Number(row.entry_delay_minutes),
    buyUsd: Number(row.buy_usd),
    sellUsd: Number(row.sell_usd),
    boughtAmount: Number(row.bought_amount),
    soldAmount: Number(row.sold_amount),
    remainingAmount: Number(row.remaining_amount),
    realizedPnl: Number(row.realized_pnl),
    unrealizedPnl: Number(row.unrealized_pnl),
    roiPct: Number(row.roi_pct),
    tradeCount: Number(row.trade_count),
    suspiciousTradeCount: Number(row.suspicious_trade_count),
  }
}

export async function syncWalletsForChain(chain: string): Promise<void> {
  if (chain !== 'solana') {
    console.warn(`[sync-wallets] Chain ${chain} not supported, skipping`)
    return
  }

  const enrichmentCache = new Map<string, { balance: number; tokensHeld: number }>()

  for (const period of allPeriodConfigs()) {
    // Only positions in churn-qualified tokens count. A wallet earns its place here by trading
    // tokens the product considers real, not by trading whatever ingestion happened to cover.
    const performanceRows = await queryClickhouse<PerformanceRow>(
      `SELECT p.* FROM wallet_token_performance AS p FINAL
       INNER JOIN (
         SELECT DISTINCT contract
         FROM token_analytics FINAL
         WHERE chain = {chain:String} AND churn_qualified = 1
       ) AS q ON q.contract = p.contract
       WHERE p.chain = {chain:String}
         AND p.period_days = {periodDays:UInt16}
         AND p.last_trade_at >= now() - toIntervalDay({activeDays:UInt16})`,
      {
        chain,
        periodDays: period.days,
        activeDays: Math.min(period.days, config.worker.alphaMaxTokenAgeDays),
      }
    )
    const groups = new Map<string, PerformanceRow[]>()
    for (const row of performanceRows) {
      const current = groups.get(row.wallet_address) ?? []
      current.push(row)
      groups.set(row.wallet_address, current)
    }

    const candidates = [...groups.entries()]
      .map(([address, rows]) => {
        const performances = rows.map(asPerformance)
        const wins = performances.filter((p) => p.realizedPnl + p.unrealizedPnl > 0).length
        const qualifiedTokens = new Set(rows.map((row) => row.contract)).size
        const qualifiedProfitUsd = performances.reduce(
          (sum, p) => sum + p.realizedPnl + p.unrealizedPnl,
          0
        )
        return {
          address,
          rows,
          qualifiedTokens,
          qualifiedWins: wins,
          qualifiedProfitUsd,
          qualifiedWinRate: rows.length > 0 ? (wins / rows.length) * 100 : 0,
          score: scoreWallet(
            performances,
            config.worker.alphaMinDistinctTokens,
            config.worker.alphaMinPeriodProfitUsd,
            config.worker.alphaMinPeriodTrades
          ),
        }
      })
      // Repeat performance across the qualified set: one profitable token is luck.
      .filter(
        (candidate) =>
          candidate.qualifiedTokens >= config.worker.walletMinQualifiedTokens &&
          candidate.qualifiedProfitUsd > 0
      )
      .sort((a, b) => {
        if (b.qualifiedTokens !== a.qualifiedTokens) return b.qualifiedTokens - a.qualifiedTokens
        return b.qualifiedProfitUsd - a.qualifiedProfitUsd
      })
      .slice(0, config.worker.walletHeliusEnrichLimit)

    const updatedAt = formatNow()
    const analyticsRows: Record<string, unknown>[] = []
    for (const candidate of candidates) {
      let enrichment = enrichmentCache.get(candidate.address)
      if (!enrichment) {
        enrichment = {
          balance: await enrichSolanaWalletBalanceUsd(
            candidate.address,
            config.worker.solUsdPriceFallback
          ),
          tokensHeld: (await getSolanaWalletTokenCount(candidate.address)) ?? 0,
        }
        enrichmentCache.set(candidate.address, enrichment)
      }
      const totalTrades = candidate.rows.reduce((sum, row) => sum + Number(row.trade_count), 0)
      const totalVolume = candidate.rows.reduce((sum, row) => sum + Number(row.buy_usd) + Number(row.sell_usd), 0)
      const latestActive = Math.max(...candidate.rows.map((row) => asTimestamp(row.last_trade_at)))
      const totalProfit = candidate.score.realizedProfit + candidate.score.unrealizedProfit
      // Reported for the wallets view and debugging. Token scoring recomputes reputation
      // per-token with the scored token excluded, so it never reads this value back.
      const reputation = scoreWalletReputation(
        candidate.rows.map(asPerformance),
        config.worker.alphaMinClosedPositions
      )

      analyticsRows.push({
        address: candidate.address,
        chain,
        period_days: period.days,
        balance: enrichment.balance,
        total_profit: totalProfit,
        win_rate: candidate.rows.length > 0 ? (candidate.score.wins / candidate.rows.length) * 100 : 0,
        trades: totalTrades,
        volume: totalVolume,
        tokens_held: enrichment.tokensHeld,
        last_active: new Date(latestActive * 1000).toISOString(),
        smart_score: candidate.score.smartScore,
        young_token_trades: candidate.rows.length,
        young_token_wins: candidate.score.wins,
        median_roi_pct: candidate.score.medianRoiPct,
        avg_entry_delay_minutes: candidate.score.avgEntryDelayMinutes,
        realized_profit: candidate.score.realizedProfit,
        unrealized_profit: candidate.score.unrealizedProfit,
        concentration_pct: candidate.score.concentrationPct,
        reputation_score: reputation.reputationScore,
        closed_positions: reputation.closedPositions,
        reputation_sample: candidate.rows.length,
        qualified_tokens: candidate.qualifiedTokens,
        qualified_wins: candidate.qualifiedWins,
        qualified_profit_usd: candidate.qualifiedProfitUsd,
        qualified_win_rate: candidate.qualifiedWinRate,
        risk_flags: [...new Set([...candidate.score.riskFlags, ...reputation.riskFlags])],
        updated_at: updatedAt,
      })
    }

    if (performanceRows.length > 0) {
      const previous = await queryClickhouse<{ address: string }>(
        `SELECT address FROM wallet_analytics FINAL
         WHERE chain = {chain:String} AND period_days = {periodDays:UInt16} AND smart_score > 0`,
        { chain, periodDays: period.days }
      )
      const active = new Set(candidates.map((candidate) => candidate.address))
      for (const stale of previous.filter((wallet) => !active.has(wallet.address))) {
        analyticsRows.push({
          address: stale.address,
          chain,
          period_days: period.days,
          balance: 0,
          total_profit: 0,
          win_rate: 0,
          trades: 0,
          volume: 0,
          tokens_held: 0,
          last_active: new Date().toISOString(),
          smart_score: 0,
          young_token_trades: 0,
          young_token_wins: 0,
          median_roi_pct: 0,
          avg_entry_delay_minutes: 0,
          realized_profit: 0,
          unrealized_profit: 0,
          concentration_pct: 0,
          risk_flags: ['no_longer_eligible'],
          updated_at: updatedAt,
        })
      }
    }
    await insertClickhouse('wallet_analytics', analyticsRows)
    console.log(`[sync-wallets] Wrote ${candidates.length} smart wallets for ${chain}/${period.label}`)
  }
}

export async function syncAllWallets(): Promise<void> {
  for (const chain of config.worker.syncChains) await syncWalletsForChain(chain)
}
