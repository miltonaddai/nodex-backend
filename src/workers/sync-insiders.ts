import { config } from '../config'
import {
  classifyPriceShape,
  collectLaunchActivity,
  insiderScore,
  insiderStatus,
  scoreLaunch,
  sharedFunderLinks,
  sharedFunders,
  type LaunchInsiderReport,
  type LaunchTransaction,
} from '../lib/insider-detection'
import { getPriceHistory, getRecentlyListedTokens, type TokenData } from '../services/birdeye'
import { insertClickhouse, queryClickhouse } from '../services/clickhouse'
import { cacheDeletePattern } from '../services/redis'
import { getSolanaTokenMarketHealth } from '../services/dexscreener'
import {
  getFundingSource,
  getRawTransactionsForAddress,
  getTokenHolderBalances,
  getTokenSupply,
  isHighThroughputWallet,
  rawToLaunchTransaction,
} from '../services/helius'

/**
 * Insider plays: tokens whose launch was bought by wallets under common control.
 *
 * This runs on its own candidate list because the churn screen rejects these tokens outright.
 * Each token's launch is analyzed once (the launch window never changes), then every run
 * refreshes how much of that supply the insiders still hold and where price sits relative to
 * the launch spike.
 */

interface StoredAnalysis {
  contract: string
  name: string
  symbol: string
  image_url: string
  launched_at: string
  analyzed_at: string
  launch_buyers: number
  launch_supply_pct: number
  creation_block_supply_pct: number
  linked_wallets: number
  linked_supply_pct: number
  clusters: number
  largest_cluster_supply_pct: number
  co_signed_links: number
  fee_paid_links: number
  split_transfers: number
  shared_funder_links: number
  insider_wallets: string[]
  insider_acquired_pct: number
  launch_score: number
  evidence: string[]
  holders: number
}

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace('T', ' ').slice(0, 19)
}

function parseDate(value: string): number {
  return Math.floor(Date.parse(`${value.replace(' ', 'T')}Z`) / 1000)
}

/**
 * Analyzes a token's launch window for insider bundles. Also used by the token scanner, which
 * passes a smaller funder-lookup budget to keep an interactive scan quick.
 */
export async function analyzeLaunch(
  mint: string,
  supply: number,
  funderLookups = config.worker.insiderFunderLookups
): Promise<{ report: LaunchInsiderReport; launchedAt: number } | null> {
  // The earliest successful transactions as raw data, in one call: 10 credits per 100 instead
  // of a signature listing plus 100 credits per 100 through the Enhanced parser.
  const { data } = await getRawTransactionsForAddress(mint, { sortOrder: 'asc', limit: config.worker.insiderMaxLaunchTxs })
  const first = data.find((tx) => tx.blockTime)
  if (!first?.blockTime) return null
  // The window is timed from the first token movement inside collectLaunchActivity, since
  // trading can open well after the mint is created.
  const txs: LaunchTransaction[] = data.map(rawToLaunchTransaction)
  const activity = collectLaunchActivity(txs, mint, config.worker.insiderLaunchWindowSeconds)

  const lookups = [...activity.buyers.values()]
    .filter((buyer) => buyer.bought + buyer.received > 0)
    .sort((a, b) => b.bought + b.received - (a.bought + a.received))
    .slice(0, funderLookups)
  const funders = new Map<string, string | null>()
  for (const buyer of lookups) {
    try {
      funders.set(buyer.wallet, await getFundingSource(buyer.wallet))
    } catch {
      funders.set(buyer.wallet, null)
    }
  }
  const hotWallets = new Set<string>()
  for (const funder of sharedFunders(funders)) {
    try {
      if (await isHighThroughputWallet(funder)) hotWallets.add(funder)
    } catch {
      // An unverifiable funder is treated as a hot wallet, so it never creates a false link.
      hotWallets.add(funder)
    }
  }

  const report = scoreLaunch(activity, sharedFunderLinks(funders, hotWallets), supply)
  return { report, launchedAt: activity.firstTimestamp || first.blockTime }
}

function launchFields(report: LaunchInsiderReport) {
  return {
    launch_buyers: report.launchBuyers,
    launch_supply_pct: report.launchSupplyPct,
    creation_block_supply_pct: report.creationBlockSupplyPct,
    linked_wallets: report.linkedWallets,
    linked_supply_pct: report.linkedSupplyPct,
    clusters: report.clusters.length,
    largest_cluster_supply_pct: report.largestClusterSupplyPct,
    co_signed_links: report.coSignedLinks,
    fee_paid_links: report.feePaidLinks,
    split_transfers: report.splitTransfers,
    shared_funder_links: report.sharedFunderLinks,
    insider_wallets: report.insiderWallets,
    insider_acquired_pct: report.insiderAcquiredPct,
    launch_score: report.launchScore,
    evidence: report.evidence,
  }
}

export async function syncInsiderPlays(chain: string): Promise<void> {
  if (chain !== 'solana') return
  if (!config.helius.apiKey || !config.birdeye.apiKey) {
    console.warn('[insiders] Requires Helius and Birdeye keys; skipping')
    return
  }
  const now = Math.floor(Date.now() / 1000)

  const analyzed = new Set(
    (
      await queryClickhouse<{ contract: string }>(
        `SELECT DISTINCT contract FROM token_insider_analysis WHERE chain = {chain:String}`,
        { chain }
      )
    ).map((row) => row.contract)
  )

  const candidates = await getRecentlyListedTokens(chain, {
    maxAgeDays: config.worker.insiderScanMaxAgeDays,
    limit: config.worker.insiderScanCandidates,
    pageSize: 50,
    minLiquidity: config.worker.insiderScanMinLiquidity,
    minVolume: config.worker.insiderScanMinVolume24h,
    minHolders: config.worker.insiderScanMinHolders,
    maxMarketCap: 0,
  })
  const fresh = candidates
    .filter((token) => !analyzed.has(token.address))
    .filter((token) => token.listedAt > 0 && token.listedAt <= now - config.worker.insiderScanMinAgeMinutes * 60)
    .sort((a, b) => b.volume24h - a.volume24h)
    .slice(0, config.worker.insiderMaxNewPerRun)

  const newRows: Record<string, unknown>[] = []
  for (const token of fresh) {
    try {
      const { supply } = await getTokenSupply(token.address)
      if (supply <= 0) continue
      const result = await analyzeLaunch(token.address, supply)
      if (!result) continue
      newRows.push({
        contract: token.address,
        chain,
        name: token.name,
        symbol: token.symbol,
        image_url: token.imageUrl,
        launched_at: formatDate(result.launchedAt),
        analyzed_at: formatDate(now),
        holders: Math.round(token.holders),
        ...launchFields(result.report),
      })
      console.log(
        `[insiders] ${token.symbol}: launch score ${result.report.launchScore}, ` +
          `${result.report.insiderWallets.length} insider wallets took ${result.report.insiderAcquiredPct}% at launch`
      )
    } catch (error) {
      console.warn(`[insiders] Launch analysis failed for ${token.symbol} (${token.address}):`, error)
    }
  }

  const stored = await queryClickhouse<StoredAnalysis>(
    `SELECT contract, name, symbol, image_url, launched_at, analyzed_at, launch_buyers, launch_supply_pct,
            creation_block_supply_pct, linked_wallets, linked_supply_pct, clusters, largest_cluster_supply_pct,
            co_signed_links, fee_paid_links, split_transfers, shared_funder_links, insider_wallets,
            insider_acquired_pct, launch_score, evidence, holders
     FROM token_insider_analysis FINAL
     WHERE chain = {chain:String} AND launched_at >= now() - toIntervalDay({trackDays:UInt16})
       -- A token whose refresh already found its pool pulled is not refreshed again. New
       -- analyses have not been refreshed yet (updated_at equals analyzed_at), so they stay in.
       AND NOT (liquidity < {minLiquidity:Float64} AND updated_at > analyzed_at)
     ORDER BY insider_score DESC
     LIMIT {limit:UInt32}`,
    {
      chain,
      trackDays: config.worker.insiderTrackDays,
      limit: config.worker.insiderMaxTracked,
      minLiquidity: config.worker.insiderMinLiquidity,
    }
  )
  const tracked = new Map<string, StoredAnalysis>()
  for (const row of stored) tracked.set(row.contract, row)
  for (const row of newRows) tracked.set(row.contract as string, row as unknown as StoredAnalysis)
  if (tracked.size === 0) {
    console.log('[insiders] No tokens to track yet')
    return
  }

  const markets = await getSolanaTokenMarketHealth([...tracked.keys()])
  const refreshed: Record<string, unknown>[] = []
  for (const row of tracked.values()) {
    try {
      const { supply, decimals } = await getTokenSupply(row.contract)
      const balances = await getTokenHolderBalances(row.contract, decimals)
      const held = row.insider_wallets.reduce((sum, wallet) => sum + (balances.get(wallet) ?? 0), 0)
      const holdingPct = supply > 0 ? Math.round((held / supply) * 10_000) / 100 : 0

      const launchedAt = parseDate(row.launched_at)
      const market = markets.get(row.contract)
      const ageDays = (now - launchedAt) / 86_400
      const series = await getPriceHistory(row.contract, chain, ageDays <= 3 ? '15m' : '1H', launchedAt - 60, now)
      const shape = classifyPriceShape(series, supply, launchedAt, market?.marketCap ?? 0)
      const status = insiderStatus(holdingPct, row.insider_acquired_pct)

      refreshed.push({
        ...row,
        chain,
        holders: balances.size || row.holders,
        insider_holding_pct: holdingPct,
        insider_status: status,
        price: market?.price ?? 0,
        market_cap: shape.currentMc,
        liquidity: market?.liquidity ?? 0,
        volume_24h: market?.volume24h ?? 0,
        price_change_24h: market?.priceChange24h ?? 0,
        launch_high_mc: shape.launchHighMc,
        post_launch_low_mc: shape.postLaunchLowMc,
        ath_mc: shape.athMc,
        price_pattern: shape.pattern,
        insider_score: insiderScore(row.launch_score, holdingPct, row.insider_acquired_pct),
        updated_at: formatDate(Math.floor(Date.now() / 1000)),
      })
    } catch (error) {
      console.warn(`[insiders] Refresh failed for ${row.symbol} (${row.contract}):`, error)
      // Keep a newly analyzed token even if its first refresh fails.
      if (newRows.some((r) => r.contract === row.contract)) {
        // Keep updated_at equal to analyzed_at: liquidity was never measured, so the next run
        // must refresh it rather than treat the missing value as a pulled pool.
        refreshed.push({ ...row, chain, updated_at: row.analyzed_at })
      }
    }
  }

  await insertClickhouse('token_insider_analysis', refreshed)
  // The page caches until the next scheduled run, so drop it once fresh data is written.
  await cacheDeletePattern(`*:insiders:${chain}:*`)
  console.log(`[insiders] ${newRows.length} new launches analyzed, ${refreshed.length} tokens refreshed`)
}

export async function syncAllInsiderPlays(): Promise<void> {
  for (const chain of config.worker.syncChains) {
    try {
      await syncInsiderPlays(chain)
    } catch (error) {
      console.error(`[insiders] Failed ${chain}:`, error)
    }
  }
}

/** Analyzes one token on demand, for backfilling a token the scan missed. */
export async function analyzeInsiderToken(chain: string, token: TokenData): Promise<void> {
  const { supply } = await getTokenSupply(token.address)
  const result = await analyzeLaunch(token.address, supply)
  if (!result) throw new Error(`No launch transactions found for ${token.address}`)
  await insertClickhouse('token_insider_analysis', [
    {
      contract: token.address,
      chain,
      name: token.name,
      symbol: token.symbol,
      image_url: token.imageUrl,
      launched_at: formatDate(result.launchedAt),
      analyzed_at: formatDate(Math.floor(Date.now() / 1000)),
      holders: Math.round(token.holders),
      ...launchFields(result.report),
      updated_at: formatDate(Math.floor(Date.now() / 1000)),
    },
  ])
}
