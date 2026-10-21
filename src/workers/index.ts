import { config } from '../config'
import { recordPipelineSchedule } from '../services/clickhouse'
import { heliusCreditsUsed } from '../services/helius'
import { refreshAllWalletTokenPerformance, syncAllAlphaTrades } from './sync-alpha'
import { syncAllTopTraders } from './sync-top-traders'
import { syncAllTokens } from './sync-tokens'
import { syncAllWallets } from './sync-wallets'
import { refreshAllTokenMarketHealth } from './sync-market-health'
import { syncAllInsiderPlays } from './sync-insiders'
import { syncAllSmartMoneyBuys } from './sync-smart-money'
import { syncTokenSightings } from './sync-sightings'

let pipelineTimer: NodeJS.Timeout | null = null
let healthTimer: NodeJS.Timeout | null = null
let running = false
let nextRunAt = new Date()
let healthRunning = false

function elapsedSeconds(startedAt: number): string {
  return ((Date.now() - startedAt) / 1000).toFixed(1)
}

/** Credits by call type spent since `before`, for the per-step log line. */
function creditsSince(before: Record<string, number>): { total: number; byKind: Record<string, number> } {
  const byKind: Record<string, number> = {}
  let total = 0
  for (const [kind, value] of Object.entries(heliusCreditsUsed().byKind)) {
    const spent = value - (before[kind] ?? 0)
    if (spent > 0) {
      byKind[kind] = spent
      total += spent
    }
  }
  return { total, byKind }
}

/** Runs one pipeline step and logs the Helius credits it spent (estimated from published prices). */
async function meteredStep(name: string, step: () => Promise<unknown>): Promise<void> {
  const before = heliusCreditsUsed().byKind
  try {
    await step()
  } finally {
    const spent = creditsSince(before)
    console.log(`[credits] ${name}: ${spent.total} Helius credits ${JSON.stringify(spent.byKind)}`)
  }
}

async function runHealthRefresh(): Promise<void> {
  if (healthRunning) return
  healthRunning = true
  const startedAt = Date.now()
  console.log(`[worker] Market health refresh started at ${new Date(startedAt).toISOString()}`)
  try {
    await refreshAllTokenMarketHealth()
    console.log(`[worker] Market health refresh completed in ${elapsedSeconds(startedAt)}s`)
  } catch (error) {
    console.error('[worker] Token market health refresh failed:', error)
  } finally {
    healthRunning = false
  }
}

/**
 * Records when the next pipeline run is due, and whether one is writing now. The frontend counts
 * down to the next run and the API keeps serving its cached snapshot until then.
 */
async function recordSchedule(isRunning: boolean): Promise<void> {
  try {
    await recordPipelineSchedule(nextRunAt, isRunning)
  } catch (error) {
    console.warn('[worker] Could not record pipeline schedule:', error)
  }
}

/** setInterval fires at a fixed rate, so the next tick is one interval after this one. */
function advanceNextRun(): void {
  nextRunAt = new Date(Date.now() + config.worker.tokenSyncIntervalMinutes * 60 * 1000)
}

/** Runs every pipeline step once. Resolves false if the run failed. */
async function runPipeline(): Promise<boolean> {
  if (running) {
    console.warn('[worker] Previous alpha pipeline is still running; skipping overlap')
    advanceNextRun()
    await recordSchedule(true)
    return true
  }
  running = true
  const startedAt = Date.now()
  advanceNextRun()
  await recordSchedule(true)
  const timeoutMs = config.worker.pipelineTimeoutMinutes * 60 * 1000
  const watchdog = setTimeout(() => {
    console.error(
      `[worker] Pipeline exceeded ${config.worker.pipelineTimeoutMinutes}m; exiting so the process manager can restart it`
    )
    process.exit(1)
  }, timeoutMs)
  console.log(`[worker] Alpha intelligence pipeline started at ${new Date(startedAt).toISOString()}`)
  try {
    const runBefore = heliusCreditsUsed().byKind
    await meteredStep('tokens', () => syncAllTokens())
    await meteredStep('market-health', () => runHealthRefresh())
    // Feeds the wallets page: tokens the most profitable wallets are net buying right now.
    await meteredStep('smart-money', () => syncAllSmartMoneyBuys())
    await meteredStep('top-traders', () => syncAllTopTraders())
    // Raw trade ingestion feeds wallet_token_trades and wallet_token_performance, which every
    // downstream step reads.
    await meteredStep('trade-ingestion', () => syncAllAlphaTrades())
    // Turns raw trades into per-wallet, per-token positions.
    await meteredStep('wallet-performance', () => refreshAllWalletTokenPerformance())
    await meteredStep('wallets', () => syncAllWallets())
    // Runs last and on its own candidate list: the churn screen above rejects bundled launches,
    // which are exactly the tokens this step exists to catch.
    await meteredStep('insiders', () => syncAllInsiderPlays())
    // Last, so it sees every market cap this run wrote. Reads ClickHouse only, no API calls.
    // Isolated so a failure here never fails the run that produced the data.
    await syncTokenSightings(new Date(startedAt)).catch((error) =>
      console.error('[worker] Token sightings update failed:', error)
    )
    // refreshTokenScores and syncAllHolderWealth are intentionally not run here.
    //
    // Both write token_analytics rows keyed by (chain, contract, period_days). Because the table
    // is a ReplacingMergeTree, re-inserting those keys without the churn columns would reset
    // churn_qualified to 0 and silently drop every discovered token older than the alpha
    // maturity window from the list. The route ranks on churn now, not alpha_score, so the alpha
    // scoring path has no consumer — re-enable it only once it preserves the churn columns.
    //
    // Trade ingestion, top traders and wallet sync stay: they feed the wallets page.
    console.log(`[credits] pipeline total: ${creditsSince(runBefore).total} Helius credits`)
    console.log(`[worker] Alpha intelligence pipeline completed in ${elapsedSeconds(startedAt)}s`)
    return true
  } catch (error) {
    console.error('[worker] Alpha intelligence pipeline failed:', error)
    return false
  } finally {
    clearTimeout(watchdog)
    running = false
    await recordSchedule(false)
  }
}

async function main(): Promise<void> {
  if (!config.worker.enabled) {
    console.log('[worker] WORKER_ENABLED=false; worker will not start')
    return
  }
  console.log('NodeX Solana alpha worker starting...')
  console.log(`Chains: ${config.worker.syncChains.join(', ')}`)

  // Once mode is for a scheduler (a Railway cron job) that starts the worker on each run. A
  // long-lived process waiting on setInterval is fragile on hosts that sleep idle services:
  // the worker makes no network calls between runs, gets put to sleep, and the timer never fires.
  if (process.argv.includes('--once') || process.env.WORKER_RUN_ONCE === 'true') {
    console.log('Mode: single run')
    const ok = await runPipeline()
    // Redis and ClickHouse keep-alive sockets would hold the process open, so exit explicitly.
    process.exit(ok ? 0 : 1)
  }

  console.log(`Pipeline interval: ${config.worker.tokenSyncIntervalMinutes}m`)
  console.log(`Pipeline timeout: ${config.worker.pipelineTimeoutMinutes}m`)
  pipelineTimer = setInterval(() => void runPipeline(), config.worker.tokenSyncIntervalMinutes * 60 * 1000)
  if (config.worker.dexScreenerRefreshIntervalMinutes > 0) {
    console.log(`Market health interval: ${config.worker.dexScreenerRefreshIntervalMinutes}m`)
    healthTimer = setInterval(
      () => void runHealthRefresh(),
      config.worker.dexScreenerRefreshIntervalMinutes * 60 * 1000
    )
  } else {
    console.log('Market health interval: with pipeline only')
  }
  await runPipeline()
}

function shutdown(): void {
  if (pipelineTimer) clearInterval(pipelineTimer)
  if (healthTimer) clearInterval(healthTimer)
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

main().catch((error) => {
  console.error('[worker] Fatal error:', error)
  process.exit(1)
})
