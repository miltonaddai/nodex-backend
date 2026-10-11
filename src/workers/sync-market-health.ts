import { config } from '../config'
import { getTokenMarketHealth } from '../services/dexscreener'
import { insertClickhouse, queryClickhouse } from '../services/clickhouse'

interface RecentToken {
  contract: string
}

function formatNow(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

/** Chains with Dexscreener coverage and a discovery step feeding token_launches. */
const MARKET_HEALTH_CHAINS = new Set(['solana', 'robinhood', 'bsc'])

export async function refreshTokenMarketHealth(chain: string): Promise<void> {
  if (!MARKET_HEALTH_CHAINS.has(chain)) return
  const tokens = await queryClickhouse<RecentToken>(
    `SELECT contract
     FROM token_launches FINAL
     WHERE chain = {chain:String}
       AND launched_at >= now() - toIntervalDay({maxAgeDays:UInt16})`,
    { chain, maxAgeDays: config.worker.alphaMaxTokenAgeDays }
  )
  if (tokens.length === 0) return

  const contracts = tokens.map((token) => token.contract)
  const marketHealth = await getTokenMarketHealth(chain, contracts)
  const checkedAt = formatNow()
  const rows = contracts.map((contract) => {
    const market = marketHealth.get(contract)
    const marketCap = market ? market.marketCap || market.fdv : 0
    const riskFlags: string[] = []
    if (!market) riskFlags.push('no_live_pair')
    if (market && market.price <= 0) riskFlags.push('zero_price')
    if (market && marketCap < config.worker.tokenMinMarketCap) riskFlags.push('low_current_market_cap')
    if (market && marketCap > config.worker.alphaMaxMarketCap) riskFlags.push('high_current_market_cap')
    if (market && market.liquidity < config.worker.tokenMinLiquidity) riskFlags.push('low_current_liquidity')
    if (market && market.volume24h < config.worker.tokenMinVolume) riskFlags.push('low_current_volume')

    return {
      contract,
      chain,
      pair_address: market?.pairAddress ?? '',
      pair_url: market?.pairUrl ?? `https://dexscreener.com/${chain}/${contract}`,
      pair_count: market?.pairCount ?? 0,
      price: market?.price ?? 0,
      market_cap: marketCap,
      fdv: market?.fdv ?? 0,
      liquidity: market?.liquidity ?? 0,
      volume_24h: market?.volume24h ?? 0,
      price_change_24h: market?.priceChange24h ?? 0,
      healthy: riskFlags.length === 0 ? 1 : 0,
      risk_flags: riskFlags,
      checked_at: checkedAt,
    }
  })
  await insertClickhouse('token_market_health', rows)
  console.log(
    `[sync-market-health] ${rows.filter((row) => row.healthy).length}/${rows.length} recent ${chain} tokens passed live market gates`
  )
}

export async function refreshAllTokenMarketHealth(): Promise<void> {
  for (const chain of config.worker.syncChains) await refreshTokenMarketHealth(chain)
}
