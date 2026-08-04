import { config } from '../config'
import { refreshAllWalletTokenPerformance, syncAllAlphaTrades } from './sync-alpha'
import { syncAllTopTraders } from './sync-top-traders'
import { syncAllTokens } from './sync-tokens'
import { syncAllWallets } from './sync-wallets'
import { refreshAllTokenMarketHealth } from './sync-market-health'

let pipelineTimer: NodeJS.Timeout | null = null
let healthTimer: NodeJS.Timeout | null = null
let running = false
let healthRunning = false

async function runHealthRefresh(): Promise<void> {
  if (healthRunning) return
  healthRunning = true
  try {
    await refreshAllTokenMarketHealth()
  } catch (error) {
    console.error('[worker] Token market health refresh failed:', error)
  } finally {
    healthRunning = false
  }
}

async function runPipeline(): Promise<void> {
  if (running) {
    console.warn('[worker] Previous alpha pipeline is still running; skipping overlap')
    return
  }
  running = true
  try {
    await syncAllTokens()
    await runHealthRefresh()
    await syncAllTopTraders()
    // Raw trade ingestion feeds wallet_token_trades and wallet_token_performance, which every
    // downstream step reads. It had no call site at all, so coverage was frozen at whatever a
    // one-off manual run had produced.
    await syncAllAlphaTrades()
    // Turns raw trades into per-wallet, per-token positions. This had no call site either, so
    // wallet_token_performance only ever held rows written by the Birdeye top-traders path and
    // nothing derived from our own ingested trades reached the wallets page.
    await refreshAllWalletTokenPerformance()
    await syncAllWallets()
    // refreshTokenScores and syncAllHolderWealth are intentionally not run here.
    //
    // Both write token_analytics rows keyed by (chain, contract, period_days). Because the table
    // is a ReplacingMergeTree, re-inserting those keys without the churn columns would reset
    // churn_qualified to 0 and silently drop every discovered token older than the alpha
    // maturity window from the list. The route ranks on churn now, not alpha_score, so the alpha
    // scoring path has no consumer — re-enable it only once it preserves the churn columns.
    //
    // Trade ingestion, top traders and wallet sync stay: they feed the wallets page.
    console.log('[worker] Alpha intelligence pipeline completed')
  } catch (error) {
    console.error('[worker] Alpha intelligence pipeline failed:', error)
  } finally {
    running = false
  }
}

async function main(): Promise<void> {
  if (!config.worker.enabled) {
    console.log('[worker] WORKER_ENABLED=false; worker will not start')
    return
  }
  console.log('NodeX Solana alpha worker starting...')
  console.log(`Chains: ${config.worker.syncChains.join(', ')}`)
  console.log(`Pipeline interval: ${config.worker.tokenSyncIntervalMinutes}m`)
  console.log(`Market health interval: ${config.worker.dexScreenerRefreshIntervalMinutes}m`)
  await runPipeline()
  pipelineTimer = setInterval(runPipeline, config.worker.tokenSyncIntervalMinutes * 60 * 1000)
  healthTimer = setInterval(
    runHealthRefresh,
    config.worker.dexScreenerRefreshIntervalMinutes * 60 * 1000
  )
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
