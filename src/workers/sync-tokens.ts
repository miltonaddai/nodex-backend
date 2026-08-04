import { config } from '../config'
import { allPeriodConfigs } from '../lib/periods'
import { discoverQualityTokens, pickTokenPeriodFields, type DiscoveredToken } from '../services/birdeye'
import { insertClickhouse } from '../services/clickhouse'

function formatNow(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

function formatUnix(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().replace('T', ' ').slice(0, 19)
}

/**
 * Discovers tokens with an organic trading shape and records them.
 *
 * The screen is churn (unique_wallet_24h / holder) rather than raw size. Volume, liquidity and
 * holder count are all cheap for a bundler to manufacture — repeated manual review found tokens
 * with thousands of holders and millions in volume that were entirely bot-driven. Churn is
 * harder to fake because a farm must choose between its wallets holding and its wallets trading.
 */
export async function syncTokensForChain(chain: string): Promise<void> {
  if (!config.birdeye.apiKey) {
    console.warn('[sync-tokens] BIRDEYE_API_KEY not set, skipping')
    return
  }

  try {
    const tokens = await discoverQualityTokens(chain, {
      minChurn: config.worker.discoveryMinChurn,
      maxChurn: config.worker.discoveryMaxChurn,
      minHolders: config.worker.discoveryMinHolders,
      minLiquidity: config.worker.discoveryMinLiquidity,
      minTrades24h: config.worker.discoveryMinTrades24h,
      minVolume24h: config.worker.discoveryMinVolume24h,
      minFdv: config.worker.discoveryMinFdv,
      maxFdv: config.worker.discoveryMaxFdv,
      maxBuySellRatio: config.worker.discoveryMaxBuySellRatio,
      minAgeHours: config.worker.discoveryMinAgeHours,
      maxAgeDays: config.worker.discoveryMaxAgeDays,
      pages: config.worker.discoveryPages,
    })

    if (tokens.length === 0) {
      console.warn(`[sync-tokens] No ${chain} tokens cleared the churn screen`)
      return
    }

    const withListing = tokens.filter((token) => token.listedAt > 0)
    const updatedAt = formatNow()

    await insertClickhouse(
      'token_launches',
      withListing.map((token) => ({
        contract: token.address,
        chain,
        name: token.name,
        symbol: token.symbol,
        image_url: token.imageUrl,
        launched_at: formatUnix(token.listedAt),
        price: token.price,
        market_cap: token.marketCap,
        fdv: token.fdv,
        volume_24h: token.volume24h,
        liquidity: token.liquidity,
        holders: Math.round(token.holders),
        price_change_24h: token.priceChange24h,
        unique_wallet_24h: Math.round(token.uniqueWallet24h),
        trade_24h_count: Math.round(token.tradeCount24h),
        buy_24h: Math.round(token.buyCount24h),
        sell_24h: Math.round(token.sellCount24h),
        churn: token.churn,
        updated_at: updatedAt,
      }))
    )

    for (const period of allPeriodConfigs()) {
      await insertClickhouse(
        'token_analytics',
        withListing.map((token) => {
          const { changePct, volume } = pickTokenPeriodFields(token, period)
          return {
            contract: token.address,
            chain,
            period_days: period.days,
            name: token.name,
            symbol: token.symbol,
            image_url: token.imageUrl,
            price: token.price,
            market_cap: token.marketCap,
            change_pct: changePct,
            volume,
            liquidity: token.liquidity,
            holders: Math.round(token.holders),
            launched_at: formatUnix(token.listedAt),
            age_days: Math.max(0, Math.floor((Date.now() / 1000 - token.listedAt) / 86_400)),
            churn: token.churn,
            unique_wallet_24h: Math.round(token.uniqueWallet24h),
            buy_sell_ratio: Number.isFinite(token.buySellRatio) ? token.buySellRatio : 0,
            churn_qualified: 1,
            risk_flags: [],
            updated_at: updatedAt,
          }
        })
      )
    }

    const summary = withListing
      .slice(0, 5)
      .map((t) => `${t.symbol}(${t.churn.toFixed(2)})`)
      .join(' ')
    console.log(
      `[sync-tokens] ${withListing.length} ${chain} tokens cleared the churn screen: ${summary}`
    )
  } catch (err) {
    console.error(`[sync-tokens] Failed ${chain}:`, err)
  }
}

export async function syncAllTokens(): Promise<void> {
  for (const chain of config.worker.syncChains) {
    await syncTokensForChain(chain)
  }
}

export type { DiscoveredToken }
